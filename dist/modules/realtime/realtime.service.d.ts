import { ConfigService } from '@nestjs/config';
import { Server } from 'socket.io';
import { RedisService } from '../../redis/redis.service';
export declare class RealtimeService {
    private redis;
    private configService;
    private readonly logger;
    private server;
    private hmacEnabled;
    constructor(redis: RedisService, configService: ConfigService);
    isHmacEnabled(): boolean;
    setServer(server: Server): void;
    generateSessionKey(): string;
    signWithKey(key: string, data: unknown): Record<string, unknown>;
    private emitSignedToRoom;
    emitSignedToRoomExcept(room: string, excludeSocketId: string, event: string, data: unknown): Promise<void>;
    emitToUser(userId: string, event: string, data: unknown): void;
    emitToOrder(orderId: string, event: string, data: unknown): void;
    setUserPresence(userId: string, online: boolean): Promise<void>;
    refreshUserPresence(userId: string): Promise<void>;
    isUserOnline(userId: string): Promise<boolean>;
    areUsersOnline(userIds: string[]): Promise<Record<string, boolean>>;
    getConnectionCount(userId: string): Promise<number>;
}
