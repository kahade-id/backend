import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { UploadModule } from '../upload/upload.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { VerificationBadgeModule } from '../users/verification-badge.module';
import { OrdersModule } from '../orders/orders.module';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { TranslationService } from './translation/translation.service';
import { ChatEphemeralPurgeService } from './chat-ephemeral-purge.service';
import { PhoneVerifiedGuard } from '../../common/guards/phone-verified.guard';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    UploadModule,
    NotificationsModule,
    VerificationBadgeModule,
    // Batch 43 BE-CHAT: OrdersService di-inject untuk order-from-chat
    // (order dari chat didelegasikan ke escrow, tanpa logika uang baru).
    // OrdersModule tidak mengimpor ChatModule, jadi tidak ada circular DI.
    OrdersModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, TranslationService, ChatEphemeralPurgeService, PhoneVerifiedGuard],
  exports: [ChatService],
})
export class ChatModule {}
