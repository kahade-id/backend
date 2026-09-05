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
var RealtimeService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.RealtimeService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto_1 = require("crypto");
const redis_service_1 = require("../../redis/redis.service");
const PRESENCE_KEY = (userId) => `presence:${userId}`;
const PRESENCE_TTL = 600;
let RealtimeService = RealtimeService_1 = class RealtimeService {
    constructor(redis, configService) {
        this.redis = redis;
        this.configService = configService;
        this.logger = new common_1.Logger(RealtimeService_1.name);
        this.server = null;
        this.hmacEnabled = false;
        const hmacKey = this.configService.get('ws.hmacKey') ?? null;
        this.hmacEnabled = !!hmacKey;
        if (!this.hmacEnabled) {
            this.logger.warn('WS_HMAC_KEY not configured — outgoing events will not be signed');
        }
    }
    isHmacEnabled() {
        return this.hmacEnabled;
    }
    setServer(server) {
        this.server = server;
    }
    generateSessionKey() {
        return (0, crypto_1.randomBytes)(32).toString('hex');
    }
    signWithKey(key, data) {
        const payload = typeof data === 'object' && data !== null ? { ...data } : { data };
        const ts = Date.now();
        payload._ts = ts;
        const raw = JSON.stringify(payload);
        payload._signature = (0, crypto_1.createHmac)('sha256', key).update(raw).digest('hex');
        return payload;
    }
    async emitSignedToRoom(room, event, data) {
        if (!this.server)
            return;
        if (!this.hmacEnabled) {
            this.server.to(room).emit(event, typeof data === 'object' && data !== null ? { ...data } : { data });
            return;
        }
        try {
            const sockets = await this.server.in(room).fetchSockets();
            for (const sock of sockets) {
                const s = sock;
                const key = s._hmacSessionKey;
                if (!key) {
                    this.logger.warn(`Skipping unsigned realtime event ${event} for socket ${sock.id}`);
                    continue;
                }
                sock.emit(event, this.signWithKey(key, data));
            }
        }
        catch (err) {
            this.logger.warn(`Failed to emit signed event to room ${room}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async emitSignedToRoomExcept(room, excludeSocketId, event, data) {
        if (!this.server)
            return;
        if (!this.hmacEnabled) {
            this.server.to(room).except(excludeSocketId).emit(event, typeof data === 'object' && data !== null ? { ...data } : { data });
            return;
        }
        try {
            const sockets = await this.server.in(room).fetchSockets();
            for (const sock of sockets) {
                if (sock.id === excludeSocketId)
                    continue;
                const s = sock;
                const key = s._hmacSessionKey;
                if (!key) {
                    this.logger.warn(`Skipping unsigned realtime event ${event} for socket ${sock.id}`);
                    continue;
                }
                sock.emit(event, this.signWithKey(key, data));
            }
        }
        catch (err) {
            this.logger.warn(`Failed to emit signed event to room ${room}: ${err instanceof Error ? err.message : String(err)}`);
            this.server.to(room).except(excludeSocketId).emit(event, typeof data === 'object' && data !== null ? { ...data } : { data });
        }
    }
    emitToUser(userId, event, data) {
        if (!this.server)
            return;
        void this.emitSignedToRoom(`user:${userId}`, event, data);
    }
    emitToOrder(orderId, event, data) {
        if (!this.server)
            return;
        void this.emitSignedToRoom(`order:${orderId}`, event, data);
    }
    async setUserPresence(userId, online) {
        try {
            if (online) {
                await this.redis.incr(PRESENCE_KEY(userId));
                await this.redis.expire(PRESENCE_KEY(userId), PRESENCE_TTL);
                return;
            }
            const newCount = await this.redis.decr(PRESENCE_KEY(userId));
            if (newCount <= 0) {
                await this.redis.del(PRESENCE_KEY(userId));
            }
            else {
                await this.redis.expire(PRESENCE_KEY(userId), PRESENCE_TTL);
            }
        }
        catch (err) {
            this.logger.warn(`Presence update failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    async refreshUserPresence(userId) {
        try {
            const current = await this.redis.get(PRESENCE_KEY(userId));
            if (current !== null) {
                await this.redis.expire(PRESENCE_KEY(userId), PRESENCE_TTL);
            }
        }
        catch (err) {
            this.logger.warn(`Presence TTL refresh failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        }
    }
    async isUserOnline(userId) {
        try {
            const val = await this.redis.get(PRESENCE_KEY(userId));
            return val !== null && parseInt(val, 10) > 0;
        }
        catch {
            return false;
        }
    }
    async areUsersOnline(userIds) {
        const result = {};
        if (userIds.length === 0)
            return result;
        try {
            const keys = userIds.map((uid) => `${this.redis.getPrefix()}${PRESENCE_KEY(uid)}`);
            const values = await this.redis.getClient().mget(...keys);
            for (let i = 0; i < userIds.length; i++) {
                result[userIds[i]] = values[i] !== null && parseInt(values[i], 10) > 0;
            }
        }
        catch {
            for (const uid of userIds) {
                result[uid] = false;
            }
        }
        return result;
    }
    async getConnectionCount(userId) {
        try {
            const val = await this.redis.get(PRESENCE_KEY(userId));
            return val ? parseInt(val, 10) : 0;
        }
        catch {
            return 0;
        }
    }
};
exports.RealtimeService = RealtimeService;
exports.RealtimeService = RealtimeService = RealtimeService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [redis_service_1.RedisService,
        config_1.ConfigService])
], RealtimeService);
