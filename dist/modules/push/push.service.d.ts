import { OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
export declare class PushService implements OnModuleInit {
    private configService;
    private prisma;
    private readonly logger;
    private messaging;
    constructor(configService: ConfigService, prisma: PrismaService);
    onModuleInit(): void;
    private enrichPushData;
    private asNotificationType;
    private deriveActionUrl;
    private sanitizePushData;
    private getPushPrefFieldForType;
    private getAndroidChannelId;
    private shouldSendPush;
    private isExpoToken;
    private sendViaExpo;
    sendToUser(userId: string, title: string, body: string, data?: Record<string, string>): Promise<void>;
    sendToMultipleUsers(userIds: string[], title: string, body: string, data?: Record<string, string>): Promise<void>;
}
