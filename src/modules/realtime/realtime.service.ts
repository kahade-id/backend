import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { createHmac, randomBytes } from 'crypto';
import { RedisService } from '../../redis/redis.service';

const PRESENCE_KEY = (userId: string) => `presence:${userId}`;
const PRESENCE_TTL = 600;

interface SocketWithHmac extends Socket {
  _hmacSessionKey?: string;
}

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;
  private hmacEnabled = false;

  constructor(
    private redis: RedisService,
    private configService: ConfigService,
  ) {
    const hmacKey = this.configService.get<string>('ws.hmacKey') ?? null;
    this.hmacEnabled = !!hmacKey;
    if (!this.hmacEnabled) {
      this.logger.warn('WS_HMAC_KEY not configured — outgoing events will not be signed');
    }
  }

  isHmacEnabled(): boolean {
    return this.hmacEnabled;
  }

  setServer(server: Server): void {
    this.server = server;
  }

  generateSessionKey(): string {
    return randomBytes(32).toString('hex');
  }

  signWithKey(key: string, data: unknown): Record<string, unknown> {
    const payload: Record<string, unknown> = typeof data === 'object' && data !== null ? { ...data as Record<string, unknown> } : { data };
    const ts = Date.now();
    payload._ts = ts;
    const raw = JSON.stringify(payload);
    payload._signature = createHmac('sha256', key).update(raw).digest('hex');
    return payload;
  }

  private async emitSignedToRoom(room: string, event: string, data: unknown): Promise<void> {
    if (!this.server) return;
    if (!this.hmacEnabled) {
      this.server.to(room).emit(event, typeof data === 'object' && data !== null ? { ...data as Record<string, unknown> } : { data });
      return;
    }
    try {
      const sockets = await this.server.in(room).fetchSockets();
      for (const sock of sockets) {
        const s = sock as unknown as SocketWithHmac;
        const key = s._hmacSessionKey;
        if (!key) {
          this.logger.warn(`Skipping unsigned realtime event ${event} for socket ${sock.id}`);
          continue;
        }
        sock.emit(event, this.signWithKey(key, data));
      }
    } catch (err) {
      // HMAC mode is an integrity boundary. Do not fall back to unsigned
      // delivery when room enumeration fails; that would silently downgrade
      // every event during a Redis/adapter incident.
      this.logger.warn(`Failed to emit signed event to room ${room}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async emitSignedToRoomExcept(room: string, excludeSocketId: string, event: string, data: unknown): Promise<void> {
    if (!this.server) return;
    if (!this.hmacEnabled) {
      this.server.to(room).except(excludeSocketId).emit(event, typeof data === 'object' && data !== null ? { ...data as Record<string, unknown> } : { data });
      return;
    }
    try {
      const sockets = await this.server.in(room).fetchSockets();
      for (const sock of sockets) {
        if (sock.id === excludeSocketId) continue;
        const s = sock as unknown as SocketWithHmac;
        const key = s._hmacSessionKey;
        if (!key) {
          this.logger.warn(`Skipping unsigned realtime event ${event} for socket ${sock.id}`);
          continue;
        }
        sock.emit(event, this.signWithKey(key, data));
      }
    } catch (err) {
      this.logger.warn(`Failed to emit signed event to room ${room}: ${err instanceof Error ? err.message : String(err)}`);
      this.server.to(room).except(excludeSocketId).emit(event, typeof data === 'object' && data !== null ? { ...data as Record<string, unknown> } : { data });
    }
  }

  emitToUser(userId: string, event: string, data: unknown): void {
    if (!this.server) return;
    void this.emitSignedToRoom(`user:${userId}`, event, data);
  }

  emitToOrder(orderId: string, event: string, data: unknown): void {
    if (!this.server) return;
    void this.emitSignedToRoom(`order:${orderId}`, event, data);
  }

  async setUserPresence(userId: string, online: boolean): Promise<void> {
    try {
      if (online) {
        await this.redis.incr(PRESENCE_KEY(userId));
        await this.redis.expire(PRESENCE_KEY(userId), PRESENCE_TTL);
        return;
      }
      const newCount = await this.redis.decr(PRESENCE_KEY(userId));
      if (newCount <= 0) {
        await this.redis.del(PRESENCE_KEY(userId));
      } else {
        await this.redis.expire(PRESENCE_KEY(userId), PRESENCE_TTL);
      }
    } catch (err) {
      this.logger.warn(`Presence update failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Refresh only the expiry of an existing presence counter. This is called
   * from the gateway's periodic authenticated-socket check and must never
   * increment the counter for an already-connected client. */
  async refreshUserPresence(userId: string): Promise<void> {
    try {
      const current = await this.redis.get(PRESENCE_KEY(userId));
      if (current !== null) {
        await this.redis.expire(PRESENCE_KEY(userId), PRESENCE_TTL);
      }
    } catch (err) {
      this.logger.warn(`Presence TTL refresh failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  async isUserOnline(userId: string): Promise<boolean> {
    try {
      const val = await this.redis.get(PRESENCE_KEY(userId));
      return val !== null && parseInt(val, 10) > 0;
    } catch {
      return false;
    }
  }

  async areUsersOnline(userIds: string[]): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    if (userIds.length === 0) return result;
    try {
      const keys = userIds.map((uid) => `${this.redis.getPrefix()}${PRESENCE_KEY(uid)}`);
      const values = await this.redis.getClient().mget(...keys);
      for (let i = 0; i < userIds.length; i++) {
        result[userIds[i]] = values[i] !== null && parseInt(values[i] as string, 10) > 0;
      }
    } catch {
      for (const uid of userIds) {
        result[uid] = false;
      }
    }
    return result;
  }

  async getConnectionCount(userId: string): Promise<number> {
    try {
      const val = await this.redis.get(PRESENCE_KEY(userId));
      return val ? parseInt(val, 10) : 0;
    } catch {
      return 0;
    }
  }
}
