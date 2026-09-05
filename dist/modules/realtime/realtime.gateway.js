"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var RealtimeGateway_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealtimeGateway = void 0;
const websockets_1 = require("@nestjs/websockets");
const common_1 = require("@nestjs/common");
const socket_io_1 = require("socket.io");
const jwt_1 = require("@nestjs/jwt");
const config_1 = require("@nestjs/config");
const prisma_service_1 = require("../../prisma/prisma.service");
const redis_service_1 = require("../../redis/redis.service");
const realtime_service_1 = require("./realtime.service");
const notifications_service_1 = require("../notifications/notifications.service");
const token_service_1 = require("../auth/token.service");
const redis_keys_1 = require("../../common/constants/redis-keys");
const app_constants_1 = require("../../common/constants/app.constants");
const WS_MSG_RATE_LIMIT = 30;
const WS_MSG_RATE_WINDOW_SECONDS = 10;
const WS_MAX_CONNECTIONS_PER_USER = 5;
const WS_TYPING_RATE_LIMIT = 5;
const WS_TYPING_RATE_WINDOW_SECONDS = 3;
const WS_TOKEN_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
let RealtimeGateway = RealtimeGateway_1 = class RealtimeGateway {
    async checkWsRateLimit(client) {
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
        }
        catch {
            this.logger.warn(`Redis unavailable for WS rate limit check — rejecting message for ${client.id} (fail-closed)`);
            client.emit('error', { message: 'Service temporarily unavailable' });
            return false;
        }
    }
    async checkTypingRateLimit(client) {
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
        }
        catch {
            this.logger.warn(`Redis unavailable for WS typing rate limit — rejecting for ${client.id} (fail-closed)`);
            return false;
        }
    }
    constructor(jwtService, configService, prisma, redisService, realtimeService, notificationsService) {
        this.jwtService = jwtService;
        this.configService = configService;
        this.prisma = prisma;
        this.redisService = redisService;
        this.realtimeService = realtimeService;
        this.notificationsService = notificationsService;
        this.logger = new common_1.Logger(RealtimeGateway_1.name);
        this.WS_CONN_PREFIX = 'ws:conn:';
        this.WS_CONN_TTL = 1200;
        this.notificationListenerRegistered = false;
        this.typingTimers = new Map();
    }
    afterInit(server) {
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
                }
                catch (err) {
                    this.logger.warn(`Failed to emit unread count for user ${data.userId}: ${err.message}`);
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
    onModuleDestroy() {
        if (this.tokenRecheckTimer) {
            clearInterval(this.tokenRecheckTimer);
            this.tokenRecheckTimer = undefined;
        }
    }
    recheckTokenExpiry() {
        if (!this.server?.sockets?.sockets)
            return;
        const sockets = this.server.sockets.sockets;
        if (!(sockets instanceof Map))
            return;
        const now = Math.floor(Date.now() / 1000);
        for (const [, socket] of sockets) {
            const client = socket;
            if (client._tokenExp && client._tokenExp <= now) {
                client.emit('error', { message: 'Token expired' });
                client.disconnect(true);
                continue;
            }
            const checks = [];
            if (client.userId) {
                checks.push(this.realtimeService.refreshUserPresence(client.userId));
                checks.push(this.redisService.expire(`${this.WS_CONN_PREFIX}${client.userId}`, this.WS_CONN_TTL));
            }
            if (client._jti) {
                checks.push(this.redisService.get((0, redis_keys_1.TOKEN_BLACKLIST)(client._jti), { throwOnError: true }).then(revoked => {
                    if (revoked) {
                        client.emit('error', { message: 'Token revoked' });
                        client.disconnect(true);
                    }
                }));
            }
            if (client._sessionId) {
                checks.push(this.redisService.get((0, redis_keys_1.SESSION_REVOKED_KEY)(client._sessionId), { throwOnError: true }).then(revoked => {
                    if (revoked) {
                        client.emit('error', { message: 'Session revoked' });
                        client.disconnect(true);
                    }
                }));
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
    extractCookieToken(cookieHeader) {
        if (!cookieHeader)
            return null;
        const match = cookieHeader.match(/(?:^|;\s*)kahade_access_token=([^;]+)/);
        return match ? match[1] : null;
    }
    async handleConnection(client) {
        try {
            const token = client.handshake.auth?.token ??
                client.handshake.headers?.authorization?.replace('Bearer ', '') ??
                this.extractCookieToken(client.handshake.headers?.cookie) ??
                null;
            if (!token) {
                client.emit('error', { message: 'Authentication required' });
                client.disconnect(true);
                return;
            }
            const secret = this.configService.get('jwt.secret');
            const payload = await this.jwtService.verifyAsync(token, {
                secret,
                audience: token_service_1.USER_TOKEN_AUDIENCE,
                issuer: token_service_1.TOKEN_ISSUER,
                algorithms: ['HS256'],
            });
            if (!payload?.sub) {
                client.emit('error', { message: 'Invalid token payload' });
                client.disconnect(true);
                return;
            }
            try {
                if (payload.jti) {
                    const isBlacklisted = await this.redisService.get((0, redis_keys_1.TOKEN_BLACKLIST)(payload.jti), { throwOnError: true });
                    if (isBlacklisted) {
                        client.emit('error', { message: 'Token has been revoked' });
                        client.disconnect(true);
                        return;
                    }
                }
                if (payload.sessionId) {
                    const sessionRevoked = await this.redisService.get((0, redis_keys_1.SESSION_REVOKED_KEY)(payload.sessionId), { throwOnError: true });
                    if (sessionRevoked) {
                        client.emit('error', { message: 'Session has been revoked' });
                        client.disconnect(true);
                        return;
                    }
                }
            }
            catch {
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
            }
            catch {
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
        }
        catch {
            client.emit('error', { message: 'Authentication failed' });
            client.disconnect(true);
        }
    }
    async handleDisconnect(client) {
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
                if (count <= 0)
                    await this.redisService.del(connKey).catch(() => undefined);
                client._connectionLeaseRegistered = false;
            }
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
    async getUserOrderRooms(userId) {
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
        }
        catch {
            return [];
        }
    }
    async isRoomParticipant(userId, roomId) {
        try {
            const chatRoom = await this.prisma.chatRoom.findUnique({
                where: { id: roomId, deletedAt: null },
                select: { orderId: true, order: { select: { orderId: true, buyerId: true, sellerId: true, deletedAt: true } } },
            });
            if (!chatRoom?.order || chatRoom.order.deletedAt)
                return { authorized: false };
            const authorized = chatRoom.order.buyerId === userId || chatRoom.order.sellerId === userId;
            return { authorized, orderId: chatRoom.order.orderId };
        }
        catch {
            return { authorized: false };
        }
    }
    async handleTypingStart(client, data) {
        if (!client.userId || !data?.roomId || typeof data.roomId !== 'string' || data.roomId.length > 100)
            return;
        if (!(await this.checkWsRateLimit(client)))
            return;
        if (!(await this.checkTypingRateLimit(client)))
            return;
        const room = await this.isRoomParticipant(client.userId, data.roomId);
        if (!room.authorized || !room.orderId)
            return;
        await this.realtimeService.emitSignedToRoomExcept(`order:${room.orderId}`, client.id, 'typing.start', {
            userId: client.userId,
            roomId: data.roomId,
        });
        const timerKey = `${client.userId}:${data.roomId}`;
        const existing = this.typingTimers.get(timerKey);
        if (existing)
            clearTimeout(existing);
        this.typingTimers.set(timerKey, setTimeout(async () => {
            this.typingTimers.delete(timerKey);
            await this.realtimeService.emitSignedToRoomExcept(`order:${room.orderId}`, client.id, 'typing.stop', {
                userId: client.userId,
                roomId: data.roomId,
            });
        }, app_constants_1.TYPING_SERVER_AUTO_STOP_MS));
    }
    async handleTypingStop(client, data) {
        if (!client.userId || !data?.roomId || typeof data.roomId !== 'string' || data.roomId.length > 100)
            return;
        if (!(await this.checkWsRateLimit(client)))
            return;
        if (!(await this.checkTypingRateLimit(client)))
            return;
        const room = await this.isRoomParticipant(client.userId, data.roomId);
        if (!room.authorized || !room.orderId)
            return;
        const timerKey = `${client.userId}:${data.roomId}`;
        const existing = this.typingTimers.get(timerKey);
        if (existing) {
            clearTimeout(existing);
            this.typingTimers.delete(timerKey);
        }
        await this.realtimeService.emitSignedToRoomExcept(`order:${room.orderId}`, client.id, 'typing.stop', {
            userId: client.userId,
            roomId: data.roomId,
        });
    }
    async handleJoinOrder(client, data) {
        if (!client.userId) {
            return { success: false, message: 'Not authenticated' };
        }
        if (!(await this.checkWsRateLimit(client)))
            return { success: false, message: 'Rate limit exceeded' };
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
    async handleLeaveOrder(client, data) {
        if (!client.userId)
            return { success: false, message: 'Not authenticated' };
        if (!data?.orderId || typeof data.orderId !== 'string' || data.orderId.length > 64)
            return { success: false };
        if (!(await this.checkWsRateLimit(client)))
            return { success: false, message: 'Rate limit exceeded' };
        const order = await this.prisma.order.findFirst({
            where: {
                orderId: data.orderId,
                OR: [{ buyerId: client.userId }, { sellerId: client.userId }],
            },
            select: { orderId: true },
        });
        if (!order)
            return { success: false, message: 'Not a participant' };
        await client.leave(`order:${data.orderId}`);
        return { success: true };
    }
    async handleJoinRoom(client, data) {
        if (!client.userId) {
            return { success: false, message: 'Not authenticated' };
        }
        if (!(await this.checkWsRateLimit(client)))
            return { success: false, message: 'Rate limit exceeded' };
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
    async handleLeaveRoom(client, data) {
        if (!client.userId)
            return { success: false, message: 'Not authenticated' };
        if (!data?.roomId)
            return { success: false };
        if (!(await this.checkWsRateLimit(client)))
            return { success: false, message: 'Rate limit exceeded' };
        const chatRoom = await this.prisma.chatRoom.findUnique({
            where: { id: data.roomId },
            select: { order: { select: { orderId: true, buyerId: true, sellerId: true } } },
        });
        if (!chatRoom?.order)
            return { success: false, message: 'Room not found' };
        if (client.userId !== chatRoom.order.buyerId && client.userId !== chatRoom.order.sellerId) {
            return { success: false, message: 'Not a participant' };
        }
        await client.leave(`order:${chatRoom.order.orderId}`);
        return { success: true };
    }
    async validateCallParticipant(userId, callId) {
        try {
            const call = await this.prisma.disputeCall.findUnique({
                where: { id: callId },
                include: {
                    dispute: {
                        include: { order: { select: { buyerId: true, sellerId: true } } },
                    },
                },
            });
            if (!call)
                return false;
            if (call.status !== 'IN_PROGRESS' && call.status !== 'ACCEPTED')
                return false;
            return call.dispute.order.buyerId === userId || call.dispute.order.sellerId === userId;
        }
        catch {
            return false;
        }
    }
    isValidSignalPayload(signal) {
        if (typeof signal !== 'object' || signal === null || Array.isArray(signal))
            return false;
        const s = signal;
        return typeof s.type === 'string';
    }
    isValidCandidatePayload(candidate) {
        if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
            return false;
        const c = candidate;
        return typeof c.candidate === 'string';
    }
    async handleCallJoin(client, data) {
        if (!client.userId)
            return { success: false, message: 'Not authenticated' };
        if (!data?.disputeId || !data?.callId)
            return { success: false, message: 'disputeId and callId are required' };
        if (!(await this.checkWsRateLimit(client)))
            return { success: false, message: 'Rate limit exceeded' };
        const call = await this.prisma.disputeCall.findUnique({
            where: { id: data.callId },
            include: {
                dispute: {
                    include: { order: { select: { buyerId: true, sellerId: true } } },
                },
            },
        });
        if (!call)
            return { success: false, message: 'Call not found' };
        if (call.dispute.order.buyerId !== client.userId && call.dispute.order.sellerId !== client.userId) {
            return { success: false, message: 'Not a participant' };
        }
        if (call.status !== 'IN_PROGRESS' && call.status !== 'ACCEPTED') {
            return { success: false, message: 'Call is not active' };
        }
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
    async handleCallLeave(client, data) {
        if (!client.userId)
            return { success: false, message: 'Not authenticated' };
        if (!data?.callId)
            return { success: false };
        if (!(await this.checkWsRateLimit(client)))
            return { success: false, message: 'Rate limit exceeded' };
        const authorized = await this.validateCallParticipant(client.userId, data.callId);
        if (!authorized)
            return { success: false, message: 'Not a participant' };
        await client.leave(`dispute-call:${data.callId}`);
        await this.realtimeService.emitSignedToRoomExcept(`dispute-call:${data.callId}`, '', 'dispute.call_peer_left', {
            userId: client.userId,
            callId: data.callId,
        });
        return { success: true };
    }
    async handleCallSignal(client, data) {
        if (!client.userId || !data?.callId || !data?.signal)
            return;
        if (!(await this.checkWsRateLimit(client)))
            return;
        if (!this.isValidSignalPayload(data.signal))
            return;
        const authorized = await this.validateCallParticipant(client.userId, data.callId);
        if (!authorized)
            return;
        await this.realtimeService.emitSignedToRoomExcept(`dispute-call:${data.callId}`, client.id, 'dispute.call_signal', {
            userId: client.userId,
            callId: data.callId,
            signal: data.signal,
        });
    }
    async handleCallIceCandidate(client, data) {
        if (!client.userId || !data?.callId || !data?.candidate)
            return;
        if (!(await this.checkWsRateLimit(client)))
            return;
        if (!this.isValidCandidatePayload(data.candidate))
            return;
        const authorized = await this.validateCallParticipant(client.userId, data.callId);
        if (!authorized)
            return;
        await this.realtimeService.emitSignedToRoomExcept(`dispute-call:${data.callId}`, client.id, 'dispute.call_ice_candidate', {
            userId: client.userId,
            callId: data.callId,
            candidate: data.candidate,
        });
    }
};
exports.RealtimeGateway = RealtimeGateway;
__decorate([
    (0, websockets_1.WebSocketServer)(),
    __metadata("design:type", socket_io_1.Server)
], RealtimeGateway.prototype, "server", void 0);
__decorate([
    (0, websockets_1.SubscribeMessage)('typing.start'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleTypingStart", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('typing.stop'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleTypingStop", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('join_order'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleJoinOrder", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('leave_order'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleLeaveOrder", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('join-room'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleJoinRoom", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('leave-room'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleLeaveRoom", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('dispute.call_join'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleCallJoin", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('dispute.call_leave'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleCallLeave", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('dispute.call_signal'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleCallSignal", null);
__decorate([
    (0, websockets_1.SubscribeMessage)('dispute.call_ice_candidate'),
    __param(0, (0, websockets_1.ConnectedSocket)()),
    __param(1, (0, websockets_1.MessageBody)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], RealtimeGateway.prototype, "handleCallIceCandidate", null);
exports.RealtimeGateway = RealtimeGateway = RealtimeGateway_1 = __decorate([
    (0, websockets_1.WebSocketGateway)({
        namespace: '/',
        transports: ['websocket'],
    }),
    __param(5, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [jwt_1.JwtService,
        config_1.ConfigService,
        prisma_service_1.PrismaService,
        redis_service_1.RedisService,
        realtime_service_1.RealtimeService,
        notifications_service_1.NotificationsService])
], RealtimeGateway);
