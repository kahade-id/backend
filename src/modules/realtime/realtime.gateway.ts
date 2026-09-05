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
import { TYPING_SERVER_AUTO_STOP_MS } from '../../common/constants/app.constants';

interface AuthenticatedSocket extends Socket {
  userId?: string;
  _connectionLeaseRegistered?: boolean;
  _presenceRegistered?: boolean;
  _tokenExp?: number;
  _jti?: string;
  _sessionId?: string;
  _hmacSessionKey?: string;
}

const WS_MSG_RATE_LIMIT = 30;
const WS_MSG_RATE_WINDOW_SECONDS = 10;
const WS_MAX_CONNECTIONS_PER_USER = 5;
const WS_TYPING_RATE_LIMIT = 5;
const WS_TYPING_RATE_WINDOW_SECONDS = 3;
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
      const count = await this.redisService.incr(key);
      if (count === 1) {
        await this.redisService.expire(key, WS_MSG_RATE_WINDOW_SECONDS);
      }
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
      const count = await this.redisService.incr(key);
      if (count === 1) {
        await this.redisService.expire(key, WS_TYPING_RATE_WINDOW_SECONDS);
      }
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

      const userRooms = await this.getUserOrderRooms(payload.sub);
      for (const room of userRooms) {
        await this.realtimeService.emitSignedToRoomExcept(room, client.id, 'user.online', { userId: payload.sub });
      }

      this.logger.debug(`Client connected: ${client.id} (user: ${payload.sub})`);
    } catch {
      client.emit('error', { message: 'Authentication failed' });
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: AuthenticatedSocket): Promise<void> {
    if (client.userId) {
      for (const [key, timer] of this.typingTimers) {
        if (key.startsWith(`${client.userId}:`)) {
          clearTimeout(timer);
          this.typingTimers.delete(key);
          const roomId = key.split(':').slice(1).join(':');
          if (roomId) {
            this.isRoomParticipant(client.userId, roomId).then(async (room) => {
              if (room.authorized && room.orderId) {
                await this.realtimeService.emitSignedToRoomExcept(`order:${room.orderId}`, client.id, 'typing.stop', {
                  userId: client.userId,
                  roomId,
                });
              }
            }).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
          }
        }
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
        const userRooms = await this.getUserOrderRooms(client.userId);
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

  private async isRoomParticipant(userId: string, roomId: string): Promise<{ authorized: boolean; orderId?: string }> {
    try {
      const chatRoom = await this.prisma.chatRoom.findUnique({
        where: { id: roomId, deletedAt: null },
        select: { orderId: true, order: { select: { orderId: true, buyerId: true, sellerId: true, deletedAt: true } } },
      });
      if (!chatRoom?.order || chatRoom.order.deletedAt) return { authorized: false };
      const authorized = chatRoom.order.buyerId === userId || chatRoom.order.sellerId === userId;
      return { authorized, orderId: chatRoom.order.orderId };
    } catch {
      return { authorized: false };
    }
  }

  private typingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  @SubscribeMessage('typing.start')
  async handleTypingStart(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ): Promise<void> {
    if (!client.userId || !data?.roomId || typeof data.roomId !== 'string' || data.roomId.length > 100) return;
    if (!(await this.checkWsRateLimit(client))) return;
    if (!(await this.checkTypingRateLimit(client))) return;
    const room = await this.isRoomParticipant(client.userId, data.roomId);
    if (!room.authorized || !room.orderId) return;
    await this.realtimeService.emitSignedToRoomExcept(`order:${room.orderId}`, client.id, 'typing.start', {
      userId: client.userId,
      roomId: data.roomId,
    });

    const timerKey = `${client.userId}:${data.roomId}`;
    const existing = this.typingTimers.get(timerKey);
    if (existing) clearTimeout(existing);
    this.typingTimers.set(timerKey, setTimeout(async () => {
      this.typingTimers.delete(timerKey);
      await this.realtimeService.emitSignedToRoomExcept(`order:${room.orderId}`, client.id, 'typing.stop', {
        userId: client.userId,
        roomId: data.roomId,
      });
    }, TYPING_SERVER_AUTO_STOP_MS));
  }

  @SubscribeMessage('typing.stop')
  async handleTypingStop(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ): Promise<void> {
    if (!client.userId || !data?.roomId || typeof data.roomId !== 'string' || data.roomId.length > 100) return;
    if (!(await this.checkWsRateLimit(client))) return;
    if (!(await this.checkTypingRateLimit(client))) return;
    const room = await this.isRoomParticipant(client.userId, data.roomId);
    if (!room.authorized || !room.orderId) return;

    const timerKey = `${client.userId}:${data.roomId}`;
    const existing = this.typingTimers.get(timerKey);
    if (existing) { clearTimeout(existing); this.typingTimers.delete(timerKey); }

    await this.realtimeService.emitSignedToRoomExcept(`order:${room.orderId}`, client.id, 'typing.stop', {
      userId: client.userId,
      roomId: data.roomId,
    });
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

    const chatRoom = await this.prisma.chatRoom.findUnique({
      where: { id: data.roomId },
      select: {
        orderId: true,
        order: { select: { orderId: true, buyerId: true, sellerId: true } },
      },
    });

    if (!chatRoom || !chatRoom.order) {
      return { success: false, message: 'Room not found' };
    }

    const { buyerId, sellerId } = chatRoom.order;
    if (client.userId !== buyerId && client.userId !== sellerId) {
      return { success: false, message: 'Not a participant of this room' };
    }

    await client.join(`order:${chatRoom.order.orderId}`);
    this.logger.debug(`User ${client.userId} joined room order:${chatRoom.order.orderId} via chat room ${data.roomId}`);
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

    const chatRoom = await this.prisma.chatRoom.findUnique({
      where: { id: data.roomId },
      select: { order: { select: { orderId: true, buyerId: true, sellerId: true } } },
    });

    if (!chatRoom?.order) return { success: false, message: 'Room not found' };

    if (client.userId !== chatRoom.order.buyerId && client.userId !== chatRoom.order.sellerId) {
      return { success: false, message: 'Not a participant' };
    }

    /*
     * D-02: leave the room the client actually joined.
     *
     * `join-room` above joins `order:${chatRoom.order.orderId}` (:478), but this handler left
     * `order:${chatRoom.orderId}` — the FK holding the internal cuid, never a real room name.
     * `socket.leave` on an unjoined room is a silent no-op, so the client stayed subscribed to
     * the order feed after closing the chat screen. Mobile emits `leave-room` on unmount
     * (`lib/hooks/useChatSocket.ts:216`) and detaches its handlers, so nothing was misrendered,
     * but the subscriptions accumulated for the life of the socket: every room the user had
     * opened kept pushing `chat.new_message` payloads down a mobile connection that discarded
     * them.
     */
    await client.leave(`order:${chatRoom.order.orderId}`);
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
