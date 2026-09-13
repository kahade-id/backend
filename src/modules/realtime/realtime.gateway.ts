import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RealtimeService } from './realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TOKEN_ISSUER, USER_TOKEN_AUDIENCE } from '../auth/token.service';
import { TOKEN_BLACKLIST, SESSION_REVOKED_KEY } from '../../common/constants/redis-keys';
import { TYPING_HOLD_MS, TYPING_REBROADCAST_INTERVAL_MS } from '../../common/constants/app.constants';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  _connectionLeaseRegistered?: boolean;
  _connectionLeaseKey?: string;
  _presenceRegistered?: boolean;
  _tokenExp?: number;
  _jti?: string;
  _sessionId?: string;
  _hmacSessionKey?: string;
}

/**
 * Status mengetik per (user, room) yang sedang aktif di worker ini.
 * `lastBroadcastAt` dipakai untuk men-throttle re-broadcast tanpa pernah
 * membiarkan indikator macet menyala.
 */
interface TypingState {
  timer: ReturnType<typeof setTimeout>;
  lastBroadcastAt: number;
  orderId: string | null;
  fullName: string | null;
}

const WS_MSG_RATE_LIMIT = 30;
const WS_MSG_RATE_WINDOW_SECONDS = 10;
const WS_MAX_CONNECTIONS_PER_USER = 5;
// Heartbeat mengetik bisa datang tiap ~1 detik dari beberapa klien sekaligus.
// Batas lama (5 event / 3 detik) hampir selalu terlampaui, dan karena event
// yang kelebihan kuota dibuang diam-diam, indikator jadi tidak pernah muncul.
// Sekarang kuota dipakai hanya untuk menahan broadcast, bukan membatalkan status.
const WS_TYPING_RATE_LIMIT = 30;
const WS_TYPING_RATE_WINDOW_SECONDS = 10;
const WS_TOKEN_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

// B-39 (audit-fix): drop the long-polling transport. Long-polling transmits the
// access token as a query string parameter on every poll which leaks into proxy
// access logs and browser history, and it cannot be authenticated with the same
// rate-limit primitives we apply to a single WebSocket upgrade. Modern Expo /
// admin clients all negotiate WebSocket cleanly; falling back to polling was
// only a legacy compatibility concession and is no longer needed.
@WebSocketGateway({
  namespace: '/',
  transports: ['websocket'],
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly WS_CONN_PREFIX = 'ws:conn:';
  // Active sockets refresh this lease every five minutes. A short lease bounds
  // stale connection-count entries after a worker crash without weakening the
  // per-user concurrent-connection limit for healthy clients.
  private readonly WS_CONN_TTL = 1200;
  private notificationListenerRegistered = false;
  private tokenRecheckTimer?: ReturnType<typeof setInterval>;

  private async checkWsRateLimit(client: AuthenticatedSocket): Promise<boolean> {
    const identity = client.userId || client.id;
    const key = `ws:msg_rate:${identity}`;
    try {
      // AUDIT-14: atomic INCR+EXPIRE (a TTL-less key would mute this socket forever).
      const count = await this.redisService.incrWithTtl(key, WS_MSG_RATE_WINDOW_SECONDS);
      if (count > WS_MSG_RATE_LIMIT) {
        client.emit('error', { message: 'Rate limit exceeded' });
        return false;
      }
      return true;
    } catch {
      this.logger.warn(`Redis unavailable for WS rate limit check — rejecting message for ${client.id} (fail-closed)`);
      client.emit('error', { message: 'Service temporarily unavailable' });
      return false;
    }
  }

  private async checkTypingRateLimit(client: AuthenticatedSocket): Promise<boolean> {
    const identity = client.userId || client.id;
    const key = `ws:typing_rate:${identity}`;
    try {
      const count = await this.redisService.incrWithTtl(key, WS_TYPING_RATE_WINDOW_SECONDS); // AUDIT-14
      if (count > WS_TYPING_RATE_LIMIT) {
        return false;
      }
      return true;
    } catch {
      this.logger.warn(`Redis unavailable for WS typing rate limit — rejecting for ${client.id} (fail-closed)`);
      return false;
    }
  }

  @WebSocketServer()
  server!: Server;

  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
    private prisma: PrismaService,
    private redisService: RedisService,
    private realtimeService: RealtimeService,
    @Optional() private notificationsService?: NotificationsService,
  ) {}

  afterInit(server: Server): void {
    this.realtimeService.setServer(server);

    if (!this.notificationListenerRegistered) {
      this.notificationListenerRegistered = true;
      this.prisma.onNotificationCreated(async (data) => {
        this.realtimeService.emitToUser(data.userId, 'notification.new', {
          title: data.title,
          body: data.body,
          ...(data.data ?? {}),
        });

        try {
                    const unreadResult = this.notificationsService
            ? await this.notificationsService.getUnreadCount(data.userId)
            : null;
          const unreadCount = unreadResult?.unreadCount ?? await this.prisma.notification.count({
            where: {
              userId: data.userId,
              isRead: false,
              deletedAt: null,
              AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
            },
          });

          this.realtimeService.emitToUser(data.userId, 'notification.unread_count', {
            unreadCount,
          });
        } catch (err) {
          this.logger.warn(`Failed to emit unread count for user ${data.userId}: ${(err as Error).message}`);
        }
      });
    }

    this.logger.log('WebSocket gateway initialized');

    if (!this.tokenRecheckTimer) {
      this.tokenRecheckTimer = setInterval(() => {
        this.recheckTokenExpiry();
      }, WS_TOKEN_RECHECK_INTERVAL_MS);
    }
  }

  onModuleDestroy(): void {
    if (this.tokenRecheckTimer) {
      clearInterval(this.tokenRecheckTimer);
      this.tokenRecheckTimer = undefined;
    }
  }

  private recheckTokenExpiry(): void {
    if (!this.server?.sockets?.sockets) return;
    const sockets = this.server.sockets.sockets;
    if (!(sockets instanceof Map)) return;
    const now = Math.floor(Date.now() / 1000);
    for (const [, socket] of sockets) {
      const client = socket as AuthenticatedSocket;
      if (client._tokenExp && client._tokenExp <= now) {
        client.emit('error', { message: 'Token expired' });
        client.disconnect(true);
        continue;
      }
      const checks: Promise<void>[] = [];
      if (client.userId) {
        checks.push(this.realtimeService.refreshUserPresence(client.userId));
        checks.push(this.redisService.expire(`${this.WS_CONN_PREFIX}${client.userId}`, this.WS_CONN_TTL));
      }
      if (client._jti) {
        checks.push(
          this.redisService.get(TOKEN_BLACKLIST(client._jti), { throwOnError: true }).then(revoked => {
            if (revoked) {
              client.emit('error', { message: 'Token revoked' });
              client.disconnect(true);
            }
          }),
        );
      }
      if (client._sessionId) {
        checks.push(
          this.redisService.get(SESSION_REVOKED_KEY(client._sessionId), { throwOnError: true }).then(revoked => {
            if (revoked) {
              client.emit('error', { message: 'Session revoked' });
              client.disconnect(true);
            }
          }),
        );
      }
      if (checks.length > 0) {
        Promise.all(checks).catch(() => {
          this.logger.error(`Redis unavailable during WS token recheck — disconnecting client ${client.id} (fail-closed)`);
          client.emit('error', { message: 'Service temporarily unavailable' });
          client.disconnect(true);
        });
      }
    }
  }

  private extractCookieToken(cookieHeader?: string): string | null {
    if (!cookieHeader) return null;
    const match = cookieHeader.match(/(?:^|;\s*)kahade_access_token=([^;]+)/);
    return match ? match[1] : null;
  }

  async handleConnection(client: AuthenticatedSocket): Promise<void> {
    try {
      const token =
        client.handshake.auth?.token ??
        client.handshake.headers?.authorization?.replace('Bearer ', '') ??
        this.extractCookieToken(client.handshake.headers?.cookie as string | undefined) ??
        null;

      if (!token) {
        client.emit('error', { message: 'Authentication required' });
        client.disconnect(true);
        return;
      }

      const secret = this.configService.get<string>('jwt.secret');
      const payload = await this.jwtService.verifyAsync(token, {
        secret,
        audience: USER_TOKEN_AUDIENCE,
        issuer: TOKEN_ISSUER,
        algorithms: ['HS256'],
      });

      if (!payload?.sub) {
        client.emit('error', { message: 'Invalid token payload' });
        client.disconnect(true);
        return;
      }

      try {
        if (payload.jti) {
          const isBlacklisted = await this.redisService.get(TOKEN_BLACKLIST(payload.jti), { throwOnError: true });
          if (isBlacklisted) {
            client.emit('error', { message: 'Token has been revoked' });
            client.disconnect(true);
            return;
          }
        }
        if (payload.sessionId) {
          const sessionRevoked = await this.redisService.get(SESSION_REVOKED_KEY(payload.sessionId), { throwOnError: true });
          if (sessionRevoked) {
            client.emit('error', { message: 'Session has been revoked' });
            client.disconnect(true);
            return;
          }
        }
      } catch {
        this.logger.error('Redis unavailable during WS auth — rejecting connection (fail-closed)');
        client.emit('error', { message: 'Service temporarily unavailable' });
        client.disconnect(true);
        return;
      }

      const wsUser = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { isActive: true, isBanned: true },
      });
      if (!wsUser || !wsUser.isActive || wsUser.isBanned) {
        client.emit('error', { message: wsUser?.isBanned ? 'Account banned' : 'Account inactive' });
        client.disconnect(true);
        return;
      }

      const connKey = `${this.WS_CONN_PREFIX}${payload.sub}`;
      const currentCount = await this.redisService.incr(connKey);
      client._connectionLeaseRegistered = true;
      // AUDIT-19: remember the lease key so the outer catch below can release it even
      // when client.userId has not been assigned yet (handleDisconnect keys off userId).
      client._connectionLeaseKey = connKey;
      try {
        await this.redisService.expire(connKey, this.WS_CONN_TTL, { throwOnError: true });
      } catch {
        await this.redisService.decr(connKey).catch(() => undefined);
        client._connectionLeaseRegistered = false;
        throw new Error('Connection lease unavailable');
      }
      if (currentCount > WS_MAX_CONNECTIONS_PER_USER) {
        await this.redisService.decr(connKey).catch(() => undefined);
        client._connectionLeaseRegistered = false;
        client.emit('error', { message: 'Too many connections' });
        client.disconnect(true);
        return;
      }

      if (client.disconnected) {
        await this.redisService.decr(connKey).catch(() => undefined);
        client._connectionLeaseRegistered = false;
        return;
      }

      client.userId = payload.sub;
      if (payload.exp) {
        client._tokenExp = payload.exp;
      }
      if (payload.jti) {
        client._jti = payload.jti;
      }
      if (payload.sessionId) {
        client._sessionId = payload.sessionId;
      }
      await client.join(`user:${payload.sub}`);
      await this.realtimeService.setUserPresence(payload.sub, true);
      client._presenceRegistered = true;

      if (this.realtimeService.isHmacEnabled()) {
        const sessionKey = this.realtimeService.generateSessionKey();
        client._hmacSessionKey = sessionKey;
        client.emit('session_hmac_token', { token: sessionKey });
      }

      const userRooms = await this.getUserPresenceRooms(payload.sub);
      for (const room of userRooms) {
        await this.realtimeService.emitSignedToRoomExcept(room, client.id, 'user.online', { userId: payload.sub });
      }

      this.logger.debug(`Client connected: ${client.id} (user: ${payload.sub})`);
    } catch {
      // AUDIT-19: release a lease that was registered before the failure; otherwise the
      // slot stays counted for the whole TTL and repeated failures permanently exhaust
      // WS_MAX_CONNECTIONS_PER_USER for a healthy client.
      if (client._connectionLeaseRegistered && client._connectionLeaseKey) {
        client._connectionLeaseRegistered = false;
        await this.redisService
          .decr(client._connectionLeaseKey)
          .catch(() => undefined);
      }
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: AuthenticatedSocket): Promise<void> {
    if (client.userId) {
      // Putus koneksi tidak boleh meninggalkan indikator "sedang mengetik"
      // yang menyala selamanya di layar lawan bicara.
      const typingKeys = [...this.typingState.keys()].filter((key) => key.startsWith(`${client.userId}:`));
      for (const key of typingKeys) {
        const roomId = key.slice(`${client.userId}:`.length);
        if (roomId) await this.clearTyping(client, roomId, key);
      }

      const connKey = `${this.WS_CONN_PREFIX}${client.userId}`;
      if (client._connectionLeaseRegistered) {
        const count = await this.redisService.decr(connKey).catch(() => 0);
        if (count <= 0) await this.redisService.del(connKey).catch(() => undefined);
        client._connectionLeaseRegistered = false;
      }
      // The presence key itself is a connection counter. Decrement it for
      // every socket that closes; only the offline broadcast waits for zero.
      if (client._presenceRegistered) {
        await this.realtimeService.setUserPresence(client.userId, false);
        client._presenceRegistered = false;
      }
      const remaining = await this.realtimeService.getConnectionCount(client.userId);
      if (remaining <= 0) {
        const userRooms = await this.getUserPresenceRooms(client.userId);
        for (const room of userRooms) {
          await this.realtimeService.emitSignedToRoomExcept(room, client.id, 'user.offline', { userId: client.userId });
        }
      }
    }
    this.logger.debug(`Client disconnected: ${client.id} (user: ${client.userId ?? 'unknown'})`);
  }

  private async getUserOrderRooms(userId: string): Promise<string[]> {
    try {
      const activeOrders = await this.prisma.order.findMany({
        where: {
          OR: [{ buyerId: userId }, { sellerId: userId }],
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
          deletedAt: null,
        },
        select: { orderId: true },
      });
      return activeOrders.map(o => `order:${o.orderId}`);
    } catch {
      return [];
    }
  }

  /**
   * Room chat aktif user (ORDER maupun INQUIRY). Presence dikirim ke sini juga
   * supaya indikator online/last-seen bekerja di chat pra-transaksi, yang tidak
   * punya order sehingga tidak masuk `getUserOrderRooms`.
   */
  private async getUserChatRooms(userId: string): Promise<string[]> {
    try {
      const rooms = await this.prisma.chatRoom.findMany({
        where: {
          deletedAt: null,
          status: 'ACTIVE',
          OR: [{ initiatorId: userId }, { counterpartId: userId }],
        },
        select: { id: true },
      });
      return rooms.map(r => `chat:${r.id}`);
    } catch {
      return [];
    }
  }

  /** Semua room tempat presence user perlu diumumkan. */
  private async getUserPresenceRooms(userId: string): Promise<string[]> {
    const [orderRooms, chatRooms] = await Promise.all([
      this.getUserOrderRooms(userId),
      this.getUserChatRooms(userId),
    ]);
    return [...new Set([...orderRooms, ...chatRooms])];
  }

  /**
   * Peserta room kini ditentukan oleh `ChatRoom.initiatorId` / `counterpartId`,
   * bukan lagi lewat relasi order. Alasannya: room INQUIRY (chat pra-transaksi)
   * tidak punya order sama sekali, dan memaksa semunya lewat `order` akan
   * membuat room itu selalu gagal otorisasi.
   *
   * Fallback ke buyer/seller order tetap dipertahankan untuk baris lama yang
   * belum ter-backfill (lihat migration 20260913_chat_trust_safety_and_features).
   */
  private async isRoomParticipant(
    userId: string,
    roomId: string,
  ): Promise<{ authorized: boolean; orderId?: string | null; participantIds: string[] }> {
    try {
      const chatRoom = await this.prisma.chatRoom.findUnique({
        where: { id: roomId, deletedAt: null },
        select: {
          orderId: true,
          initiatorId: true,
          counterpartId: true,
          order: { select: { orderId: true, buyerId: true, sellerId: true, deletedAt: true } },
        },
      });
      if (!chatRoom) return { authorized: false, participantIds: [] };
      if (chatRoom.order?.deletedAt) return { authorized: false, participantIds: [] };

      const participantIds = [chatRoom.initiatorId, chatRoom.counterpartId].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      );
      if (participantIds.length === 2) {
        const participants = participantIds;
        return {
          authorized: participants.includes(userId),
          orderId: chatRoom.order?.orderId ?? null,
          participantIds,
        };
      }

      // Fallback: baris lama yang belum ter-backfill.
      if (!chatRoom.order) return { authorized: false, participantIds: [] };
      const legacy = [chatRoom.order.buyerId, chatRoom.order.sellerId];
      return {
        authorized: legacy.includes(userId),
        orderId: chatRoom.order.orderId,
        participantIds: legacy,
      };
    } catch {
      return { authorized: false, participantIds: [] };
    }
  }

  /**
   * Status "sedang mengetik" dikelola sebagai STATE, bukan sebagai aliran event.
   *
   * Implementasi lama mengirim ulang `typing.start` ke room tiap kali klien
   * mengirim heartbeat, dengan rate limit 5 event / 3 detik. Klien mengetik
   * mengirim heartbeat jauh lebih cepat dari itu, sehingga dua hal terjadi:
   *   1. event ke-6 dan seterusnya DIBUANG secara diam-diam (return tanpa
   *      apa pun), dan karena timer auto-stop hanya di-arm saat event lolos,
   *      indikator bisa macet menyala di layar lawan bicara;
   *   2. event hanya dikirim ke `order:<orderId>`. Klien chat bergabung lewat
   *      `join-room`, dan bila room `chat:<roomId>` belum di-join (atau room
   *      tidak punya order sama sekali — room INQUIRY), tidak ada yang sampai.
   *
   * Sekarang: heartbeat hanya memperpanjang timer, broadcast di-throttle, dan
   * `typing.stop` selalu dikirim sekali saat state berakhir (klien berhenti
   * menulis, timer habis, atau socket terputus).
   */
  private typingState = new Map<string, TypingState>();

  @SubscribeMessage('typing.start')
  async handleTypingStart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ): Promise<void> {
    await this.applyTypingSignal(client, data?.roomId, true);
  }

  @SubscribeMessage('typing.stop')
  async handleTypingStop(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ): Promise<void> {
    await this.applyTypingSignal(client, data?.roomId, false);
  }

  /** Bentuk terpadu: satu event dengan flag, untuk klien yang lebih baru. */
  @SubscribeMessage('chat.typing')
  async handleChatTyping(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string; isTyping?: boolean },
  ): Promise<void> {
    await this.applyTypingSignal(client, data?.roomId, data?.isTyping !== false);
  }

  private async applyTypingSignal(
    client: AuthenticatedSocket,
    roomId: string | undefined,
    isTyping: boolean,
  ): Promise<void> {
    if (!client.userId || !roomId || typeof roomId !== 'string' || roomId.length > 100) return;
    const room = await this.isRoomParticipant(client.userId, roomId);
    if (!room.authorized) return;

    // Catatan: heartbeat typing TIDAK memakai `checkWsRateLimit` (kuota pesan
    // 30/10 detik). Mengetik bukan pesan; handler itu juga mengirim event
    // `error` ke klien saat kuota habis, yang akan membanjiri klien dengan
    // error hanya karena user sedang menulis panjang.

    const stateKey = `${client.userId}:${roomId}`;

    if (!isTyping) {
      await this.clearTyping(client, roomId, stateKey);
      return;
    }

    // Rate limit typing bersifat "silent": heartbeat yang kelebihan kuota tidak
    // membatalkan status mengetik, hanya menahan broadcast berikutnya.
    const withinRate = await this.checkTypingRateLimit(client);
    const existing = this.typingState.get(stateKey);
    const shouldBroadcast =
      withinRate &&
      (!existing || Date.now() - existing.lastBroadcastAt >= TYPING_REBROADCAST_INTERVAL_MS);

    // Timer SELALU di-arm ulang — inilah yang menjamin indikator padam hanya
    // setelah lawan bicara benar-benar berhenti, bukan setiap 4 detik.
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      void this.clearTyping(client, roomId, stateKey);
    }, TYPING_HOLD_MS);

    if (shouldBroadcast) {
      const fullName = existing?.fullName ?? (await this.lookupDisplayName(client.userId));
      await this.broadcastTyping(client, roomId, room.orderId ?? null, true, fullName);
      this.typingState.set(stateKey, {
        timer,
        lastBroadcastAt: Date.now(),
        orderId: room.orderId ?? null,
        fullName,
      });
      return;
    }

    this.typingState.set(stateKey, {
      timer,
      lastBroadcastAt: existing?.lastBroadcastAt ?? 0,
      orderId: room.orderId ?? null,
      fullName: existing?.fullName ?? null,
    });
  }

  private async clearTyping(client: AuthenticatedSocket, roomId: string, stateKey: string): Promise<void> {
    const state = this.typingState.get(stateKey);
    if (!state) return; // tidak pernah di-broadcast → tidak ada status untuk dibatalkan
    clearTimeout(state.timer);
    this.typingState.delete(stateKey);
    await this.broadcastTyping(client, roomId, state.orderId, false, state.fullName);
  }

  private async broadcastTyping(
    client: AuthenticatedSocket,
    roomId: string,
    orderId: string | null,
    isTyping: boolean,
    fullName: string | null,
  ): Promise<void> {
    const payload = {
      roomId,
      userId: client.userId,
      fullName,
      isTyping,
      // Klien bisa mematikan indikator sendiri tanpa menunggu event stop,
      // yang penting bila paket `typing.stop` hilang karena koneksi putus.
      expiresAt: new Date(Date.now() + (isTyping ? TYPING_HOLD_MS : 0)).toISOString(),
    };
    const rooms = [`chat:${roomId}`];
    if (orderId) rooms.push(`order:${orderId}`);
    // `typing.start`/`typing.stop` untuk klien lama, `chat.typing` untuk yang baru.
    const events = isTyping ? ['typing.start', 'chat.typing'] : ['typing.stop', 'chat.typing'];
    for (const room of rooms) {
      for (const event of events) {
        await this.realtimeService.emitSignedToRoomExcept(room, client.id, event, payload);
      }
    }
  }

  /** Nama tampilan di-cache per sesi mengetik agar tidak ada query per ketikan. */
  private async lookupDisplayName(userId: string): Promise<string | null> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { fullName: true, username: true },
      });
      return user?.fullName || user?.username || null;
    } catch {
      return null;
    }
  }

  @SubscribeMessage('join_order')
  async handleJoinOrder(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!client.userId) {
      return { success: false, message: 'Not authenticated' };
    }
    if (!(await this.checkWsRateLimit(client))) return { success: false, message: 'Rate limit exceeded' };

    if (!data?.orderId || typeof data.orderId !== 'string' || data.orderId.length > 64) {
      return { success: false, message: 'orderId is required and must be at most 64 characters' };
    }

    const order = await this.prisma.order.findFirst({
      where: {
        orderId: data.orderId,
        OR: [{ buyerId: client.userId }, { sellerId: client.userId }],
      },
      select: { orderId: true },
    });

    if (!order) {
      return { success: false, message: 'Order not found or not a participant' };
    }

    await client.join(`order:${data.orderId}`);
    this.logger.debug(`User ${client.userId} joined room order:${data.orderId}`);
    return { success: true };
  }

  @SubscribeMessage('leave_order')
  async handleLeaveOrder(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { orderId: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!client.userId) return { success: false, message: 'Not authenticated' };
    if (!data?.orderId || typeof data.orderId !== 'string' || data.orderId.length > 64) return { success: false };
    if (!(await this.checkWsRateLimit(client))) return { success: false, message: 'Rate limit exceeded' };

    const order = await this.prisma.order.findFirst({
      where: {
        orderId: data.orderId,
        OR: [{ buyerId: client.userId }, { sellerId: client.userId }],
      },
      select: { orderId: true },
    });
    if (!order) return { success: false, message: 'Not a participant' };

    await client.leave(`order:${data.orderId}`);
    return { success: true };
  }

  @SubscribeMessage('join-room')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!client.userId) {
      return { success: false, message: 'Not authenticated' };
    }
    if (!(await this.checkWsRateLimit(client))) return { success: false, message: 'Rate limit exceeded' };
    if (!data?.roomId || typeof data.roomId !== 'string' || data.roomId.length > 100) {
      return { success: false, message: 'roomId is required' };
    }

    const room = await this.isRoomParticipant(client.userId, data.roomId);
    if (!room.authorized) {
      return { success: false, message: 'Not a participant of this room' };
    }

    // Dua alamat: `chat:<roomId>` untuk event percakapan (satu-satunya alamat
    // yang ada untuk room INQUIRY) dan `order:<orderId>` untuk event order.
    // Sebelumnya hanya `order:<orderId>` yang di-join, sehingga event typing
    // tidak pernah sampai ke klien yang bergabung lewat jalur chat.
    await client.join(`chat:${data.roomId}`);
    if (room.orderId) await client.join(`order:${room.orderId}`);
    this.logger.debug(`User ${client.userId} joined chat:${data.roomId}${room.orderId ? ` and order:${room.orderId}` : ''}`);
    return { success: true };
  }

  @SubscribeMessage('leave-room')
  async handleLeaveRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!client.userId) return { success: false, message: 'Not authenticated' };
    if (!data?.roomId) return { success: false };
    if (!(await this.checkWsRateLimit(client))) return { success: false, message: 'Rate limit exceeded' };

    const room = await this.isRoomParticipant(client.userId, data.roomId);
    if (!room.authorized) return { success: false, message: 'Not a participant' };

    if (room.orderId) await client.leave(`order:${room.orderId}`);
    await client.leave(`chat:${data.roomId}`);

    // Keluar dari layar chat = berhenti mengetik. Tanpa ini, indikator lawan
    // bicara menunggu timer habis walau pengirim sudah menutup percakapan.
    await this.clearTyping(client, data.roomId, `${client.userId}:${data.roomId}`);
    return { success: true };
  }

  private async validateCallParticipant(userId: string, callId: string): Promise<boolean> {
    try {
      const call = await this.prisma.disputeCall.findUnique({
        where: { id: callId },
        include: {
          dispute: {
            include: { order: { select: { buyerId: true, sellerId: true } } },
          },
        },
      });
      if (!call) return false;
      if (call.status !== 'IN_PROGRESS' && call.status !== 'ACCEPTED') return false;
      return call.dispute.order.buyerId === userId || call.dispute.order.sellerId === userId;
    } catch {
      return false;
    }
  }

  private isValidSignalPayload(signal: unknown): boolean {
    if (typeof signal !== 'object' || signal === null || Array.isArray(signal)) return false;
    const s = signal as Record<string, unknown>;
    return typeof s.type === 'string';
  }

  private isValidCandidatePayload(candidate: unknown): boolean {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
    const c = candidate as Record<string, unknown>;
    return typeof c.candidate === 'string';
  }

  @SubscribeMessage('dispute.call_join')
  async handleCallJoin(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { disputeId: string; callId: string },
  ): Promise<{ success: boolean; message?: string; started?: boolean }> {
    if (!client.userId) return { success: false, message: 'Not authenticated' };
    if (!data?.disputeId || !data?.callId) return { success: false, message: 'disputeId and callId are required' };
    if (!(await this.checkWsRateLimit(client))) return { success: false, message: 'Rate limit exceeded' };

    const call = await this.prisma.disputeCall.findUnique({
      where: { id: data.callId },
      include: {
        dispute: {
          include: { order: { select: { buyerId: true, sellerId: true } } },
        },
      },
    });

    if (!call) return { success: false, message: 'Call not found' };
    if (call.dispute.order.buyerId !== client.userId && call.dispute.order.sellerId !== client.userId) {
      return { success: false, message: 'Not a participant' };
    }
    if (call.status !== 'IN_PROGRESS' && call.status !== 'ACCEPTED') {
      return { success: false, message: 'Call is not active' };
    }

    // Joining is the only moment the call actually starts, so it is the only place that can
    // stamp `startedAt`. Nothing wrote it before: the sole occurrence in the codebase was the
    // `startedAt: null` predicate in `expire-dispute-calls.service.ts`, which reaps ACCEPTED
    // calls nobody joined. With the column never written that predicate was unconditionally
    // true, so the cron flipped *every* accepted call to EXPIRED 10 minutes after acceptance —
    // including one two participants were actively talking on — and both this handler and
    // `validateCallParticipant` then refused all further signalling, dropping the call. It
    // also left `durationSeconds` at 0 for every call in `getCallHistory`.
    //
    // Guarded so only the first joiner transitions; the second peer matches 0 rows and
    // proceeds, which is why this is not treated as an error.
    const started = await this.prisma.disputeCall.updateMany({
      where: { id: data.callId, status: 'ACCEPTED' },
      data: { status: 'IN_PROGRESS', startedAt: new Date() },
    });

    await client.join(`dispute-call:${data.callId}`);
    await this.realtimeService.emitSignedToRoomExcept(`dispute-call:${data.callId}`, client.id, 'dispute.call_peer_joined', {
      userId: client.userId,
      callId: data.callId,
    });
    return { success: true, started: started.count > 0 };
  }

  @SubscribeMessage('dispute.call_leave')
  async handleCallLeave(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { callId: string },
  ): Promise<{ success: boolean; message?: string }> {
    if (!client.userId) return { success: false, message: 'Not authenticated' };
    if (!data?.callId) return { success: false };
    if (!(await this.checkWsRateLimit(client))) return { success: false, message: 'Rate limit exceeded' };

    const authorized = await this.validateCallParticipant(client.userId, data.callId);
    if (!authorized) return { success: false, message: 'Not a participant' };

    await client.leave(`dispute-call:${data.callId}`);
    await this.realtimeService.emitSignedToRoomExcept(`dispute-call:${data.callId}`, '', 'dispute.call_peer_left', {
      userId: client.userId,
      callId: data.callId,
    });
    return { success: true };
  }

  @SubscribeMessage('dispute.call_signal')
  async handleCallSignal(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { callId: string; signal: unknown },
  ): Promise<void> {
    if (!client.userId || !data?.callId || !data?.signal) return;
    if (!(await this.checkWsRateLimit(client))) return;
    if (!this.isValidSignalPayload(data.signal)) return;
    const authorized = await this.validateCallParticipant(client.userId, data.callId);
    if (!authorized) return;
    await this.realtimeService.emitSignedToRoomExcept(`dispute-call:${data.callId}`, client.id, 'dispute.call_signal', {
      userId: client.userId,
      callId: data.callId,
      signal: data.signal,
    });
  }

  @SubscribeMessage('dispute.call_ice_candidate')
  async handleCallIceCandidate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { callId: string; candidate: unknown },
  ): Promise<void> {
    if (!client.userId || !data?.callId || !data?.candidate) return;
    if (!(await this.checkWsRateLimit(client))) return;
    if (!this.isValidCandidatePayload(data.candidate)) return;
    const authorized = await this.validateCallParticipant(client.userId, data.callId);
    if (!authorized) return;
    await this.realtimeService.emitSignedToRoomExcept(`dispute-call:${data.callId}`, client.id, 'dispute.call_ice_candidate', {
      userId: client.userId,
      callId: data.callId,
      candidate: data.candidate,
    });
  }
}
