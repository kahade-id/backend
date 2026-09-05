import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';
export declare const requestContext: AsyncLocalStorage<{
    requestId: string;
}>;
type NotificationCreatedCallback = (data: {
    userId: string;
    title: string;
    body: string;
    data?: Record<string, string>;
}) => void | Promise<void>;
export declare class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger;
    private notificationCreatedCallbacks;
    private _extendedClient;
    constructor();
    get extended(): PrismaClient;
    onNotificationCreated(callback: NotificationCreatedCallback): void;
    emitNotificationCreated(data: {
        userId: string;
        title: string;
        body: string;
        data?: Record<string, string>;
    }): void;
    onModuleInit(): Promise<void>;
    private logPoolConfig;
    private applyRequestIdMiddleware;
    private validateSoftDeleteModels;
    onModuleDestroy(): Promise<void>;
    private applyExtension;
}
export {};
