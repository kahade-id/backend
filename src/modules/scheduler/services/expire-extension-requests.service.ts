import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { DeadlineExtensionStatus } from '@prisma/client';

@Injectable()
export class ExpireExtensionRequestsService {
  private readonly logger = new Logger(ExpireExtensionRequestsService.name);

  constructor(private prisma: PrismaService) {}

  // Run every 10 minutes
  @Cron('*/10 * * * *')
  async handleExpireExtensionRequests(): Promise<void> {
    try {
      const now = new Date();
      const expired = await this.prisma.orderExtensionRequest.findMany({
        where: {
          status: DeadlineExtensionStatus.PENDING,
          expiresAt: { lt: now },
        },
        select: { id: true, orderId: true },
        take: 100,
      });

      if (expired.length === 0) return;

      for (const req of expired) {
        try {
          await this.prisma.orderExtensionRequest.update({
            where: { id: req.id },
            data: { status: DeadlineExtensionStatus.EXPIRED, reviewedAt: now },
          });
          this.logger.log(`Extension request ${req.id} expired`);
        } catch (e) {
          this.logger.warn(`Failed to expire extension ${req.id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (error) {
      this.logger.error(`Failed to expire extension requests: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
    }
  }
}
