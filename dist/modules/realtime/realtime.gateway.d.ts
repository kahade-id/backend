import { OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RealtimeService } from './realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
interface AuthenticatedSocket extends Socket {
    userId?: string;
    _connectionLeaseRegistered?: boolean;
    _presenceRegistered?: boolean;
    _tokenExp?: number;
    _jti?: string;
    _sessionId?: string;
    _hmacSessionKey?: string;
}
export declare class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
    private jwtService;
    private configService;
    private prisma;
    private redisService;
    private realtimeService;
    private notificationsService?;
    private readonly logger;
    private readonly WS_CONN_PREFIX;
    private readonly WS_CONN_TTL;
    private notificationListenerRegistered;
    private tokenRecheckTimer?;
    private checkWsRateLimit;
    private checkTypingRateLimit;
    server: Server;
    constructor(jwtService: JwtService, configService: ConfigService, prisma: PrismaService, redisService: RedisService, realtimeService: RealtimeService, notificationsService?: NotificationsService | undefined);
    afterInit(server: Server): void;
    onModuleDestroy(): void;
    private recheckTokenExpiry;
    private extractCookieToken;
    handleConnection(client: AuthenticatedSocket): Promise<void>;
    handleDisconnect(client: AuthenticatedSocket): Promise<void>;
    private getUserOrderRooms;
    private isRoomParticipant;
    private typingTimers;
    handleTypingStart(client: AuthenticatedSocket, data: {
        roomId: string;
    }): Promise<void>;
    handleTypingStop(client: AuthenticatedSocket, data: {
        roomId: string;
    }): Promise<void>;
    handleJoinOrder(client: AuthenticatedSocket, data: {
        orderId: string;
    }): Promise<{
        success: boolean;
        message?: string;
    }>;
    handleLeaveOrder(client: AuthenticatedSocket, data: {
        orderId: string;
    }): Promise<{
        success: boolean;
        message?: string;
    }>;
    handleJoinRoom(client: AuthenticatedSocket, data: {
        roomId: string;
    }): Promise<{
        success: boolean;
        message?: string;
    }>;
    handleLeaveRoom(client: AuthenticatedSocket, data: {
        roomId: string;
    }): Promise<{
        success: boolean;
        message?: string;
    }>;
    private validateCallParticipant;
    private isValidSignalPayload;
    private isValidCandidatePayload;
    handleCallJoin(client: AuthenticatedSocket, data: {
        disputeId: string;
        callId: string;
    }): Promise<{
        success: boolean;
        message?: string;
        started?: boolean;
    }>;
    handleCallLeave(client: AuthenticatedSocket, data: {
        callId: string;
    }): Promise<{
        success: boolean;
        message?: string;
    }>;
    handleCallSignal(client: AuthenticatedSocket, data: {
        callId: string;
        signal: unknown;
    }): Promise<void>;
    handleCallIceCandidate(client: AuthenticatedSocket, data: {
        callId: string;
        candidate: unknown;
    }): Promise<void>;
}
export {};
