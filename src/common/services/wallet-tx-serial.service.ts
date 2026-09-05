import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { formatWIBDate } from '../utils/date.util';

@Injectable()
export class WalletTxSerialService {
  private static readonly TTL_2_DAYS = 86400 * 2;
  private readonly logger = new Logger(WalletTxSerialService.name);

  private static readonly LUA_ATOMIC_INCR = `
    local key = KEYS[1]
    local ttl = tonumber(ARGV[1])
    local current = redis.call('INCR', key)
    if current == 1 then
      redis.call('EXPIRE', key, ttl)
    end
    return current
  `;

  private static readonly LUA_SET_IF_GREATER = `
    local key = KEYS[1]
    local newVal = tonumber(ARGV[1])
    local ttl = tonumber(ARGV[2])
    local current = tonumber(redis.call('GET', key) or '0')
    if newVal > current then
      redis.call('SET', key, ARGV[1], 'EX', ttl)
      return newVal
    end
    return current
  `;

  constructor(
    private redis: RedisService,
    private prisma: PrismaService,
  ) {}

  async getNext(): Promise<number> {
    return this.getNextForPrefix('wallet_tx_serial');
  }

  private async atomicIncr(key: string): Promise<number> {
    const client = this.redis.getClient();
    const prefixedKey = this.redis.getPrefix() + key;
    const result = await client.eval(
      WalletTxSerialService.LUA_ATOMIC_INCR,
      1,
      prefixedKey,
      WalletTxSerialService.TTL_2_DAYS,
    ) as number;
    return result;
  }

  async getNextForPrefix(prefix: string): Promise<number> {
    const today = formatWIBDate().replace(/-/g, '');
    const key = `${prefix}:${today}`;
    const lockKey = `${key}:sync_lock`;
    const serial = await this.atomicIncr(key);
    if (serial === 1) {
      const acquired = await this.redis.setNx(lockKey, '1', 30);
      if (acquired) {
        try {
          const existingSerial = await this.syncFromDb(prefix, today);
          if (existingSerial > 0) {
            const newSerial = existingSerial + 1;
            const client = this.redis.getClient();
            const prefixedKey = this.redis.getPrefix() + key;
            const result = await client.eval(
              WalletTxSerialService.LUA_SET_IF_GREATER,
              1,
              prefixedKey,
              String(newSerial),
              WalletTxSerialService.TTL_2_DAYS,
            ) as number;
            return result;
          }
        } finally {
          await this.redis.del(lockKey);
        }
      } else {
        await new Promise(resolve => setTimeout(resolve, 100));
        const current = await this.redis.get(key);
        if (current) {
          const val = parseInt(current, 10);
          if (!isNaN(val) && val > serial) {
            return await this.atomicIncr(key);
          }
        }
      }
    }
    return serial;
  }

  private async syncFromDb(prefix: string, today: string): Promise<number> {
    try {
      const prefixMap: Record<string, { model: string; field: string; txPrefix: string }> = {
        wallet_tx_serial: { model: 'walletTransaction', field: 'txId', txPrefix: `WLT-${today}-` },
        dispute_serial: { model: 'dispute', field: 'disputeId', txPrefix: `DSP-${today}-` },
        payment_serial: { model: 'walletTransaction', field: 'txId', txPrefix: `PAY-${today}-` },
      };
      const config = prefixMap[prefix];
      if (!config) return 0;

      if (config.model === 'walletTransaction') {
        const maxTx = await this.prisma.walletTransaction.findFirst({
          where: { txId: { startsWith: config.txPrefix } },
          orderBy: { txId: 'desc' },
          select: { txId: true },
        });
        if (maxTx) {
          const parts = maxTx.txId.split('-');
          const existing = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(existing) && existing >= 1) {
            this.logger.warn(`DB sync for ${prefix}: recovered serial ${existing} from ${maxTx.txId}`);
            return existing;
          }
        }
      } else if (config.model === 'dispute') {
        const maxDispute = await this.prisma.dispute.findFirst({
          where: { disputeId: { startsWith: config.txPrefix } },
          orderBy: { disputeId: 'desc' },
          select: { disputeId: true },
        });
        if (maxDispute) {
          const parts = maxDispute.disputeId.split('-');
          const existing = parseInt(parts[parts.length - 1], 10);
          if (!isNaN(existing) && existing >= 1) {
            this.logger.warn(`DB sync for ${prefix}: recovered serial ${existing} from ${maxDispute.disputeId}`);
            return existing;
          }
        }
      }
    } catch (err) {
      this.logger.error(`DB sync failed for ${prefix}: ${(err as Error).message}`);
    }
    return 0;
  }
}
