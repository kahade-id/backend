import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DisputeCallStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { ensureRedisAvailable } from '../../../common/utils/redis-health.util';
import { DISPUTE_CALL_REQUEST_EXPIRY_SECONDS } from '../../../common/constants/app.constants';

@Injectable()
export class ExpireDisputeCallsService {
  private readonly logger = new Logger(ExpireDisputeCallsService.name);
  // Shared with `DisputeCallService.acceptCall` so the accept guard and this reaper cannot
  // disagree about when a request is stale.
  private readonly CALL_REQUEST_EXPIRY_SECONDS = DISPUTE_CALL_REQUEST_EXPIRY_SECONDS;

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  // SCH-017/SCH-020: Runs every minute to expire stale dispute calls (10-min expiry window)
  @Cron('* * * * *', { name: 'expire-dispute-calls' })
  async expireDisputeCalls(): Promise<void> {
    if (!(await ensureRedisAvailable(this.redis, 'expire-dispute-calls'))) return;

    const lockKey = 'cron_lock:expire_dispute_calls';
    const lockToken = randomUUID();
    const acquired = await this.redis.setNx(lockKey, lockToken, 120);
    if (!acquired) return;

    try {
      const hasTable = await this.prisma.$queryRaw<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'dispute_calls'
        ) AS exists
      `;
      if (!hasTable[0]?.exists) {
        return;
      }

      const expiryThreshold = new Date(Date.now() - this.CALL_REQUEST_EXPIRY_SECONDS * 1000);

      const requestResult = await this.prisma.disputeCall.updateMany({
        where: {
          status: DisputeCallStatus.REQUESTED,
          requestedAt: { lt: expiryThreshold },
        },
        data: {
          status: DisputeCallStatus.EXPIRED,
          endedAt: new Date(),
        },
      });

      const acceptedResult = await this.prisma.disputeCall.updateMany({
        where: {
          status: DisputeCallStatus.ACCEPTED,
          acceptedAt: { lt: expiryThreshold },
          startedAt: null,
        },
        data: {
          status: DisputeCallStatus.EXPIRED,
          endedAt: new Date(),
        },
      });

      // A call that reaches IN_PROGRESS is only ever closed by an explicit `endCall`. If both
      // participants just close the app, the row stays IN_PROGRESS forever — and
      // `DisputeCallService.requestCall` refuses to create a new call while one is REQUESTED,
      // ACCEPTED or IN_PROGRESS, so that dispute could never hold another call again.
      //
      // Bounded by each row's own `maxDurationSeconds` rather than a constant, since it is a
      // per-row column. Raw SQL because `durationSeconds` is derived from that row's
      // `startedAt`, which `updateMany` cannot express.
      const inProgressCount = await this.prisma.$executeRaw`
        UPDATE "dispute_calls"
        SET "status" = 'ENDED'::"DisputeCallStatus",
            "endedAt" = NOW(),
            "durationSeconds" = LEAST(
              "maxDurationSeconds",
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - "startedAt")))::int)
            ),
            "updatedAt" = NOW()
        WHERE "status" = 'IN_PROGRESS'::"DisputeCallStatus"
          AND "startedAt" IS NOT NULL
          AND "startedAt" < NOW() - ("maxDurationSeconds" * INTERVAL '1 second')
      `;

      const totalExpired = requestResult.count + acceptedResult.count + inProgressCount;
      if (totalExpired > 0) {
        this.logger.log(`Expired ${requestResult.count} requested, ${acceptedResult.count} unjoined accepted, and ended ${inProgressCount} over-duration dispute call(s)`);
      }
    } catch (error) {
      const msg = (error as Error).message ?? '';
      if (msg.includes('P2021') || msg.includes('does not exist')) {
        this.logger.warn('dispute_calls table missing — run prisma migrate deploy');
        return;
      }
      this.logger.error('ExpireDisputeCalls FAILED', error);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken).catch((err) => this.logger.warn(`silent-catch: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
}
