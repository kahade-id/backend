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
import { AdminRole } from '@prisma/client';
import type { SupportConversationStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RealtimeService } from './realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TOKEN_ISSUER, USER_TOKEN_AUDIENCE, ADMIN_TOKEN_AUDIENCE } from '../auth/token.service';
import { TOKEN_BLACKLIST, SESSION_REVOKED_KEY, ADMIN_TOKEN_BLACKLIST } from '../../common/constants/redis-keys';
import { TYPING_HOLD_MS, TYPING_REBROADCAST_INTERVAL_MS } from '../../common/constants/app.constants';
import { wsOnConnect, wsOnDisconnect } from '../observability/ws-metrics.service';
import { SupportChatService } from '../support/support-chat.service';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  /** POIN 5: 'admin' untuk agen support (token admin), 'user' untuk pengguna. */
  role?: 'user' | 'admin';
  adminId?: string;
  adminRole?: AdminRole;
  /** Room support.* yang di-join socket ini (untuk event leave saat disconnect). */
  _supportRooms?: Set<string>;
  _connectionLeaseRegistered?: boolean;
  _connectionLeaseKey?: string;
  _presenceRegistered?: boolean;
  _tokenExp?: number;
  _tokenIat?: number;
  _isAdminToken?: boolean;
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
  username: string | null;
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
    // POIN 5: handler livechat support. Disediakan SupportModule yang
    // di-import RealtimeModule (tidak sirkular: SupportModule tidak
    // meng-import RealtimeModule).
    private supportChatService: SupportChatService,
    @Optional() private notificationsService?: NotificationsService,
  ) {}

  afterInit(server: Server): void {
    this.realtimeService.setServer(server);

    if (!this.notificationListenerRegistered) {
      this.notificationListenerRegistered = true;
      this.prisma.onNotificationCreated(async (data) => {
        // BFI-120: sertakan identitas notifikasi di payload `notification.new`
        // agar klien bisa mark-as-read presisi & deep-link tanpa round-trip
        // refetch. Signature `emitNotificationCreated` (60+ call site) TIDAK
        // membawa notifId → resolve best-effort di sini:
        // 1) `data.data.notificationId` bila pembuat menyertakannya
        //    (mis. chat.service menyertakan notifId baris notification);
        // 2) baris notification terbaru milik user dgn title+body sama.
        // Kegagalan lookup TIDAK menggagalkan emit (notifId: null).
        let notifId: string | null =
          typeof data.data?.notificationId === 'string' && data.data.notificationId
            ? data.data.notificationId
            : null;
        let notifType: string | null =
          typeof data.data?.notificationType === 'string' && data.data.notificationType
            ? data.data.notificationType
            : typeof data.data?.type === 'string' && data.data.type
              ? data.data.type
              : null;
        if (notifId === null) {
          try {
            const row = await this.prisma.notification.findFirst({
              where: { userId: data.userId, title: data.title, body: data.body },
              orderBy: { createdAt: 'desc' },
              select: { notifId: true, type: true },
            });
            if (row) {
              notifId = row.notifId;
              if (notifType === null) notifType = row.type;
            }
          } catch (err) {
            this.logger.warn(
              `Failed to resolve notifId for notification.new (user ${data.userId}): ${(err as Error).message}`,
            );
          }
        }
        this.realtimeService.emitToUser(data.userId, 'notification.new', {
          title: data.title,
          body: data.body,
          ...(data.data ?? {}),
          // Diletakkan SETELAH spread agar menang atas kunci `data` yang
          // bentrok (alias `type` di data.data bukan identitas kanonis).
          notifId,
          type: notifType,
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
      if (client.adminId) {
        checks.push(this.realtimeService.refreshUserPresence(client.adminId));
        checks.push(this.redisService.expire(`${this.WS_CONN_PREFIX}admin:${client.adminId}`, this.WS_CONN_TTL));
      }
      if (client._jti) {
        // POIN 5: token admin memakai daftar blacklist admin yang terpisah.
        const blacklistKey = client._isAdminToken ? ADMIN_TOKEN_BLACKLIST(client._jti) : TOKEN_BLACKLIST(client._jti);
        checks.push(
          this.redisService.get(blacklistKey, { throwOnError: true }).then(revoked => {
            if (revoked) {
              client.emit('error', { message: 'Token revoked' });
              client.disconnect(true);
            }
          }),
        );
      }
      // POIN 5: token admin yang dicabut via admin_revoked:<id> (pola JwtAdminGuard).
      if (client._isAdminToken && client.adminId) {
        const adminId = client.adminId;
        const issuedAt = client._tokenIat ?? 0;
        checks.push(
          this.redisService.get(`admin_revoked:${adminId}`, { throwOnError: true }).then(raw => {
            if (!raw) return;
            const revokedAt = Number(raw);
            if (!Number.isFinite(revokedAt) || revokedAt <= 1 || issuedAt <= revokedAt) {
              client.emit('error', { message: 'Admin token has been revoked' });
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

  /**
   * POIN 5 (2026-10-04): DUA jalur autentikasi pada SATU gateway (namespace `/`).
   *   1. Token user (aplikasi mobile / bantuan.kahade.id) — jalur existing.
   *   2. Token admin (agen support dari admin.kahade.id) — secret & audience
   *      berbeda (jwt.adminSecret / kahade-admin-api); hanya role
   *      SUPER_ADMIN & CUSTOMER_SUPPORT yang diterima.
   *
   * Satu gateway dipakai ulang (bukan @WebSocketGateway baru) supaya auth
   * fail-closed, rate limit, lease koneksi, presence, dan HMAC tetap satu
   * implementasi — menduplikasi ~400 baris auth berisiko security drift.
   * Event livechat support memakai prefix `support.*` dan room
   * `support:<conversationId>`.
   */
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

      // 1) Coba token user (jalur existing).
      let principal: { kind: 'user'; payload: any } | { kind: 'admin'; payload: any; role: AdminRole } | null = null;
      try {
        const userPayload = await this.jwtService.verifyAsync(token, {
          secret: this.configService.get<string>('jwt.secret'),
          audience: USER_TOKEN_AUDIENCE,
          issuer: TOKEN_ISSUER,
          algorithms: ['HS256'],
        });
        if (userPayload?.sub) principal = { kind: 'user', payload: userPayload };
      } catch {
        // Bukan token user — lanjut ke percobaan token admin di bawah.
      }

      // 2) Fallback: token admin (agen support).
      if (!principal) {
        let unavailable = false;
        let adminAuth: { payload: any; role: AdminRole } | null = null;
        try {
          adminAuth = await this.verifySupportAdminToken(token);
        } catch {
          // Redis down saat verifikasi admin — fail-closed seperti jalur user.
          unavailable = true;
        }
        if (unavailable) {
          this.logger.error('Redis unavailable during WS admin auth — rejecting connection (fail-closed)');
          client.emit('error', { message: 'Service temporarily unavailable' });
          client.disconnect(true);
          return;
        }
        if (adminAuth) principal = { kind: 'admin', payload: adminAuth.payload, role: adminAuth.role };
      }

      if (!principal) {
        client.emit('error', { message: 'Authentication failed' });
        client.disconnect(true);
        return;
      }

      const payload = principal.payload;
      const principalId: string = payload.sub;

      // Pemeriksaan khusus token user (blacklist, sesi, status akun) — sama
      // persis seperti sebelum POIN 5. Pemeriksaan token admin sudah dilakukan
      // di verifySupportAdminToken (pola JwtAdminGuard).
      if (principal.kind === 'user') {
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
          where: { id: principalId },
          select: { isActive: true, isBanned: true },
        });
        if (!wsUser || !wsUser.isActive || wsUser.isBanned) {
          client.emit('error', { message: wsUser?.isBanned ? 'Account banned' : 'Account inactive' });
          client.disconnect(true);
          return;
        }
      }

      // Lease koneksi per-principal. Admin memakai namespace kunci sendiri
      // agar tidak bertabrakan dengan user (id dari tabel berbeda).
      const connKey = principal.kind === 'admin'
        ? `${this.WS_CONN_PREFIX}admin:${principalId}`
        : `${this.WS_CONN_PREFIX}${principalId}`;
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

      if (principal.kind === 'admin') {
        client.adminId = principalId;
        client.role = 'admin';
        client.adminRole = principal.role;
        client._isAdminToken = true;
      } else {
        client.userId = principalId;
        client.role = 'user';
      }
      // G493: metrik koneksi WebSocket (tanpa userId/IP di store — hanya counter).
      wsOnConnect(
        client.id,
        principalId,
        (client.handshake.auth?.appVersion ?? client.handshake.query?.appVersion) as string | undefined,
      );
      if (payload.exp) {
        client._tokenExp = payload.exp;
      }
      if (typeof payload.iat === 'number') {
        client._tokenIat = payload.iat;
      }
      if (payload.jti) {
        client._jti = payload.jti;
      }
      if (payload.sessionId) {
        client._sessionId = payload.sessionId;
      }

      if (this.realtimeService.isHmacEnabled()) {
        const sessionKey = this.realtimeService.generateSessionKey();
        client._hmacSessionKey = sessionKey;
        client.emit('session_hmac_token', { token: sessionKey });
      }

      if (principal.kind === 'admin') {
        await client.join(`admin:${principalId}`);
        // Room bersama agen support — untuk event perubahan antrean.
        await client.join('support:agents');
        await this.realtimeService.setUserPresence(principalId, true);
        client._presenceRegistered = true;

        const agentRooms = await this.getAdminPresenceRooms(principalId);
        for (const room of agentRooms) {
          await this.realtimeService.emitSignedToRoomExcept(room, client.id, 'support.agent_presence', {
            agentId: principalId,
            online: true,
          });
        }
        this.logger.debug(`Admin client connected: ${client.id} (admin: ${principalId}, role: ${principal.role})`);
      } else {
        await client.join(`user:${principalId}`);
        await this.realtimeService.setUserPresence(principalId, true);
        client._presenceRegistered = true;

        const userRooms = await this.getUserPresenceRooms(principalId);
        for (const room of userRooms) {
          await this.realtimeService.emitSignedToRoomExcept(room, client.id, 'user.online', { userId: principalId });
        }
        this.logger.debug(`Client connected: ${client.id} (user: ${principalId})`);
      }
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

  /**
   * Verifikasi token admin untuk agen support — pola JwtAdminGuard
   * (blacklist jti, admin_revoked, status akun, kunci) + pembatasan role
   * support. Mengembalikan null bila BUKAN token admin yang valid;
   * melempar bila Redis tidak tersedia (fail-closed di pemanggil).
   */
  private async verifySupportAdminToken(token: string): Promise<{ payload: any; role: AdminRole } | null> {
    let payload: any;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get<string>('jwt.adminSecret'),
        audience: ADMIN_TOKEN_AUDIENCE,
        issuer: TOKEN_ISSUER,
        algorithms: ['HS256'],
      });
    } catch {
      return null;
    }
    if (!payload?.sub || !payload?.jti) return null;

    const isBlacklisted = await this.redisService.get(ADMIN_TOKEN_BLACKLIST(payload.jti), { throwOnError: true });
    if (isBlacklisted) return null;

    const revokedAtRaw = await this.redisService.get(`admin_revoked:${payload.sub}`, { throwOnError: true });
    if (revokedAtRaw) {
      const revokedAt = Number(revokedAtRaw);
      const issuedAt = typeof payload.iat === 'number' ? payload.iat : 0;
      if (!Number.isFinite(revokedAt) || revokedAt <= 1 || issuedAt <= revokedAt) return null;
    }

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: payload.sub },
      select: { isActive: true, deletedAt: true, lockedUntil: true, role: true },
    });
    if (!admin || !admin.isActive || admin.deletedAt) return null;
    if (admin.lockedUntil && admin.lockedUntil > new Date()) return null;
    if (admin.role !== AdminRole.CUSTOMER_SUPPORT && admin.role !== AdminRole.SUPER_ADMIN) return null;
    return { payload, role: admin.role };
  }

  async handleDisconnect(client: AuthenticatedSocket): Promise<void> {
    // G493: metrik koneksi WebSocket.
    const principalId = client.userId ?? client.adminId;
    wsOnDisconnect(client.id, principalId);
    if (principalId) {
      // Putus koneksi tidak boleh meninggalkan indikator "sedang mengetik"
      // yang menyala selamanya di layar lawan bicara (hanya jalur chat user).
      if (client.userId) {
        const typingKeys = [...this.typingState.keys()].filter((key) => key.startsWith(`${client.userId}:`));
        for (const key of typingKeys) {
          const roomId = key.slice(`${client.userId}:`.length);
          if (roomId) await this.clearTyping(client, roomId, key);
        }
      }

      // POIN 5: beritahu penghuni room support yang ditinggalkan.
      if (client._supportRooms && client._supportRooms.size > 0) {
        const isAdmin = client.role === 'admin';
        for (const room of client._supportRooms) {
          await this.realtimeService.emitSignedToRoomExcept(room, client.id, isAdmin ? 'support.agent_left' : 'support.user_left', {
            conversationId: room.replace(/^support:/, ''),
            ...(isAdmin ? { agentId: client.adminId } : { userId: client.userId }),
          });
        }
        client._supportRooms.clear();
      }

      if (client._connectionLeaseRegistered) {
        // Kunci lease disimpan saat konek (berbeda untuk admin) — jangan
        // dihitung ulang dari userId.
        const leaseKey = client._connectionLeaseKey ?? `${this.WS_CONN_PREFIX}${principalId}`;
        const count = await this.redisService.decr(leaseKey).catch(() => 0);
        if (count <= 0) await this.redisService.del(leaseKey).catch(() => undefined);
        client._connectionLeaseRegistered = false;
      }
      // The presence key itself is a connection counter. Decrement it for
      // every socket that closes; only the offline broadcast waits for zero.
      if (client._presenceRegistered) {
        await this.realtimeService.setUserPresence(principalId, false);
        client._presenceRegistered = false;
      }
      const remaining = await this.realtimeService.getConnectionCount(principalId);
      if (remaining <= 0) {
        if (client.role === 'admin' && client.adminId) {
          // POIN 5: presence agen ke room percakapan yang ia tangani.
          const agentRooms = await this.getAdminPresenceRooms(client.adminId);
          for (const room of agentRooms) {
            await this.realtimeService.emitSignedToRoomExcept(room, client.id, 'support.agent_presence', {
              agentId: client.adminId,
              online: false,
            });
          }
        } else {
          const userRooms = await this.getUserPresenceRooms(principalId);
          for (const room of userRooms) {
            await this.realtimeService.emitSignedToRoomExcept(room, client.id, 'user.offline', { userId: principalId });
          }
        }
      }
    }
    this.logger.debug(`Client disconnected: ${client.id} (principal: ${principalId ?? 'unknown'})`);
  }

  /**
   * Room percakapan support yang ditangani agen ini dan masih terbuka —
   * untuk broadcast presence agen.
   */
  private async getAdminPresenceRooms(adminId: string): Promise<string[]> {
    try {
      const convs = await this.prisma.supportConversation.findMany({
        where: {
          assignedAgentId: adminId,
          status: { in: ['ASSIGNED', 'OPEN'] as SupportConversationStatus[] },
        },
        select: { id: true },
      });
      return convs.map((c) => `support:${c.id}`);
    } catch {
      return [];
    }
  }

  /**
   * Room percakapan support aktif milik user — supaya event `user.online` /
   * `user.offline` juga sampai ke agen yang sedang membuka room support.
   */
  private async getUserSupportRooms(userId: string): Promise<string[]> {
    try {
      const convs = await this.prisma.supportConversation.findMany({
        where: {
          userId,
          status: { in: ['WAITING', 'ASSIGNED', 'OPEN'] as SupportConversationStatus[] },
        },
        select: { id: true },
      });
      return convs.map((c) => `support:${c.id}`);
    } catch {
      return [];
    }
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
    const [orderRooms, chatRooms, supportRooms] = await Promise.all([
      this.getUserOrderRooms(userId),
      this.getUserChatRooms(userId),
      // POIN 5: agen di room support perlu tahu user online/offline.
      this.getUserSupportRooms(userId),
    ]);
    return [...new Set([...orderRooms, ...chatRooms, ...supportRooms])];
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
      const username = existing?.username ?? (await this.lookupDisplayName(client.userId));
      await this.broadcastTyping(client, roomId, room.orderId ?? null, true, username);
      this.typingState.set(stateKey, {
        timer,
        lastBroadcastAt: Date.now(),
        orderId: room.orderId ?? null,
        username,
      });
      return;
    }

    this.typingState.set(stateKey, {
      timer,
      lastBroadcastAt: existing?.lastBroadcastAt ?? 0,
      orderId: room.orderId ?? null,
      username: existing?.username ?? null,
    });
  }

  private async clearTyping(client: AuthenticatedSocket, roomId: string, stateKey: string): Promise<void> {
    const state = this.typingState.get(stateKey);
    if (!state) return; // tidak pernah di-broadcast → tidak ada status untuk dibatalkan
    clearTimeout(state.timer);
    this.typingState.delete(stateKey);
    await this.broadcastTyping(client, roomId, state.orderId, false, state.username);
  }

  private async broadcastTyping(
    client: AuthenticatedSocket,
    roomId: string,
    orderId: string | null,
    isTyping: boolean,
    username: string | null,
  ): Promise<void> {
    // BFI-115: bentuk kanonis — { roomId, userId, username, isTyping,
    // expiresAt } top-level, SAMA dengan jalur REST (sendTypingIndicator).
    // Field `username` berisi nama tampilan (fullName || username).
    const payload = {
      roomId,
      userId: client.userId,
      username,
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

  /**
   * Nama tampilan di-cache per sesi mengetik agar tidak ada query per ketikan.
   * Dipetakan ke field payload `username` (kontrak BFI-115).
   */
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

  // SYS-C-403: handler 'join_order'/'leave_order' DIHAPUS — tidak ada pemakai; join lewat 'join-room'.

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

  // SYS-C-403: scaffolding 'dispute.call_*' DIHAPUS — keputusan: fitur call dibatalkan.

  // ============================================================
  // POIN 5 (2026-10-04) — LIVECHAT SUPPORT (websocket penuh)
  // ============================================================
  // Event client→server: support.join, support.leave, support.message,
  //   support.typing.
  // Event server→client: support.message.new, support.typing,
  //   support.agent_joined, support.agent_left, support.user_joined,
  //   support.user_left, support.agent_presence, support.assigned,
  //   support.escalated, support.queue.changed (room support:agents).
  // Detail protokol wire ada di laporan tugas POIN 5.

  /**
   * Otorisasi percakapan support untuk socket ini: user harus pemilik
   * percakapan; admin (role support, sudah diautentikasi saat konek) boleh
   * mengakses semua percakapan.
   */
  private async getSupportConversationForSocket(
    client: AuthenticatedSocket,
    conversationId: string,
  ): Promise<{ id: string; userId: string } | null> {
    try {
      const conv = await this.prisma.supportConversation.findUnique({
        where: { id: conversationId },
        select: { id: true, userId: true },
      });
      if (!conv) return null;
      if (client.role === 'admin' && client.adminId) return conv;
      if (client.role !== 'admin' && client.userId && conv.userId === client.userId) return conv;
      return null;
    } catch {
      return null;
    }
  }

  private trackSupportRoom(client: AuthenticatedSocket, room: string): void {
    if (!client._supportRooms) client._supportRooms = new Set<string>();
    client._supportRooms.add(room);
  }

  @SubscribeMessage('support.join')
  async handleSupportJoin(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ): Promise<{
    success: boolean;
    message?: string;
    conversation?: unknown;
    messages?: unknown[];
    agentOnline?: boolean | null;
    queuePosition?: number | null;
  }> {
    const principalId = client.userId ?? client.adminId;
    if (!principalId) return { success: false, message: 'Not authenticated' };
    if (!(await this.checkWsRateLimit(client))) return { success: false, message: 'Rate limit exceeded' };
    const conversationId = data?.conversationId;
    if (!conversationId || typeof conversationId !== 'string' || conversationId.length > 100) {
      return { success: false, message: 'conversationId is required' };
    }
    const conv = await this.getSupportConversationForSocket(client, conversationId);
    if (!conv) return { success: false, message: 'Not authorized' };

    const room = `support:${conv.id}`;
    await client.join(room);
    this.trackSupportRoom(client, room);

    const isAdmin = client.role === 'admin';
    const viewer = isAdmin
      ? { kind: 'admin' as const, id: client.adminId! }
      : { kind: 'user' as const, id: client.userId! };
    const [conversation, history] = await Promise.all([
      isAdmin
        ? this.supportChatService.getConversationForAdmin(conv.id)
        : this.supportChatService.getConversationForUser(client.userId!, conv.id),
      // 30 pesan terakhir (terlama → terbaru) untuk render langsung.
      this.supportChatService.getMessages(conv.id, viewer, undefined, 30),
    ]);

    let agentOnline: boolean | null = null;
    let queuePosition: number | null = null;
    if (!isAdmin) {
      const assignedAgentId = (conversation as { assignedAgent?: { id: string } | null } | null)?.assignedAgent?.id ?? null;
      agentOnline = assignedAgentId ? await this.realtimeService.isUserOnline(assignedAgentId) : null;
      queuePosition = await this.supportChatService.getQueuePosition(conv.id);
    }

    await this.realtimeService.emitSignedToRoomExcept(
      room,
      client.id,
      isAdmin ? 'support.agent_joined' : 'support.user_joined',
      isAdmin
        ? { conversationId: conv.id, agentId: client.adminId }
        : { conversationId: conv.id, userId: client.userId },
    );

    return { success: true, conversation, messages: history.data, agentOnline, queuePosition };
  }

  @SubscribeMessage('support.leave')
  async handleSupportLeave(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string },
  ): Promise<{ success: boolean }> {
    const conversationId = data?.conversationId;
    if (typeof conversationId === 'string' && conversationId.length <= 100) {
      const room = `support:${conversationId}`;
      await client.leave(room);
      client._supportRooms?.delete(room);
      const isAdmin = client.role === 'admin';
      await this.realtimeService.emitSignedToRoomExcept(
        room,
        client.id,
        isAdmin ? 'support.agent_left' : 'support.user_left',
        {
          conversationId,
          ...(isAdmin ? { agentId: client.adminId } : { userId: client.userId }),
        },
      );
    }
    return { success: true };
  }

  @SubscribeMessage('support.message')
  async handleSupportMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string; content?: string; attachments?: string[] },
  ): Promise<{ success: boolean; message?: string; data?: unknown }> {
    const principalId = client.userId ?? client.adminId;
    if (!principalId) return { success: false, message: 'Not authenticated' };
    if (!(await this.checkWsRateLimit(client))) return { success: false, message: 'Rate limit exceeded' };
    const conversationId = data?.conversationId;
    if (!conversationId || typeof conversationId !== 'string' || conversationId.length > 100) {
      return { success: false, message: 'conversationId is required' };
    }
    const conv = await this.getSupportConversationForSocket(client, conversationId);
    if (!conv) return { success: false, message: 'Not authorized' };

    try {
      // Balasan pertama agen = claim otomatis (WAITING → ASSIGNED → OPEN).
      const saved =
        client.role === 'admin'
          ? await this.supportChatService.sendAgentMessage(client.adminId!, conversationId, data?.content, data?.attachments)
          : await this.supportChatService.sendUserMessage(client.userId!, conversationId, data?.content, data?.attachments);
      return { success: true, data: saved };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send message';
      return { success: false, message };
    }
  }

  @SubscribeMessage('support.typing')
  async handleSupportTyping(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { conversationId: string; isTyping?: boolean },
  ): Promise<void> {
    const principalId = client.userId ?? client.adminId;
    const conversationId = data?.conversationId;
    if (!principalId || !conversationId || typeof conversationId !== 'string' || conversationId.length > 100) return;
    // Rate limit typing bersifat silent (pola chat): heartbeat berlebih hanya
    // menahan broadcast, tidak membatalkan status.
    if (!(await this.checkTypingRateLimit(client))) return;
    const conv = await this.getSupportConversationForSocket(client, conversationId);
    if (!conv) return;
    const isTyping = data.isTyping !== false;
    // Stateless (tanpa state machine seperti chat): klien memakai expiresAt
    // untuk mematikan indikator bila paket stop hilang.
    await this.realtimeService.emitSignedToRoomExcept(`support:${conv.id}`, client.id, 'support.typing', {
      conversationId: conv.id,
      senderType: client.role === 'admin' ? 'AGENT' : 'USER',
      senderId: principalId,
      isTyping,
      expiresAt: new Date(Date.now() + (isTyping ? TYPING_HOLD_MS : 0)).toISOString(),
    });
  }
}
