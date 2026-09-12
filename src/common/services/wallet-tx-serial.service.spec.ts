import { WalletTxSerialService } from './wallet-tx-serial.service';
import { RedisService } from '../../redis/redis.service';
import { PrismaService } from '../../prisma/prisma.service';
import { formatWIBDate } from '../utils/date.util';

/**
 * R2-D (audit): at day start the Redis counter key may sit far below the serials
 * already persisted in PostgreSQL (restart/rollover). Previously only the caller
 * that drew `1` triggered the DB re-sync, and concurrent losers returned raw small
 * values — so financial rows were stamped with duplicate day-serials (the ids stay
 * distinct thanks to the random suffix, but the serial uniqueness the ledger
 * promises was silently lost). The protocol now gates every early caller through
 * the sync.
 */
function buildFakes(dbMaxSerial: number) {
  const store = new Map<string, string>();
  const today = formatWIBDate().replace(/-/g, '');
  const key = `wallet_tx_serial:${today}`;

  const redis: any = {
    getPrefix: () => '',
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    setNx: jest.fn(async (k: string, v: string) => {
      if (store.has(k)) return false;
      store.set(k, v);
      return true;
    }),
    del: jest.fn(async (k: string) => { store.delete(k); }),
    getClient: () => ({
      eval: jest.fn(async (script: string, _n: number, prefixedKey: string, a1: string, a2?: string) => {
        if (script.includes('INCR')) {
          const next = (parseInt(store.get(key) ?? '0', 10) || 0) + 1;
          store.set(key, String(next));
          return next;
        }
        // SET_IF_GREATER
        const newVal = parseInt(a1, 10);
        const current = parseInt(store.get(key) ?? '0', 10) || 0;
        if (newVal > current) {
          store.set(key, String(newVal));
          return newVal;
        }
        return current;
      }),
    }),
  };

  const prisma: any = {
    walletTransaction: {
      findFirst: jest.fn(async () =>
        dbMaxSerial > 0 ? { txId: `WLT-${today}-${String(dbMaxSerial).padStart(6, '0')}` } : null,
      ),
    },
  };

  return { redis: redis as RedisService, prisma: prisma as PrismaService, store, key };
}

describe('WalletTxSerialService', () => {
  it('syncs past the existing DB serial when the day key starts fresh', async () => {
    const fakes = buildFakes(5);
    const service = new WalletTxSerialService(fakes.redis, fakes.prisma);

    // Pre-fix: losers could receive 2..5 → duplicate of persisted ids. Post-fix:
    // the first winner returns 6 (DB max + 1) and later callers keep counting up.
    const results = await Promise.all([
      service.getNext(),
      service.getNext(),
      service.getNext(),
      service.getNext(),
    ]);

    expect(new Set(results).size).toBe(results.length);
    expect(Math.min(...results)).toBeGreaterThan(5);
    const after = await service.getNext();
    expect(after).toBeGreaterThan(Math.max(...results));
    expect(fakes.prisma.walletTransaction.findFirst).toHaveBeenCalled();
    expect(fakes.store.get(`wallet_tx_serial:${formatWIBDate().replace(/-/g, '')}:synced`)).toBe('1');
  });

  it('does not hit the database once the day is marked synced', async () => {
    const fakes = buildFakes(5);
    const service = new WalletTxSerialService(fakes.redis, fakes.prisma);
    await service.getNext(); // triggers sync + marker
    (fakes.prisma.walletTransaction.findFirst as jest.Mock).mockClear();

    const next = await service.getNext();
    const after = await service.getNext();
    expect(fakes.prisma.walletTransaction.findFirst).not.toHaveBeenCalled();
    expect(after).toBe(next + 1);
  });

  it('marks the day synced even when there is no DB history to recover', async () => {
    const fakes = buildFakes(0);
    const service = new WalletTxSerialService(fakes.redis, fakes.prisma);
    const first = await service.getNext();
    expect(first).toBeGreaterThanOrEqual(1);
    expect(fakes.store.get(`wallet_tx_serial:${formatWIBDate().replace(/-/g, '')}:synced`)).toBe('1');
  });
});
