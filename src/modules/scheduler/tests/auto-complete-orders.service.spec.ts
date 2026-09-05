import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { AutoCompleteDeliveredOrdersService } from '../services/auto-complete-orders.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';

/*
 * C-01 / C-02 / C-03 regression suite for the hourly auto-complete cron.
 *
 * The smoke spec only ever asserted the service starts and bails out when Redis is
 * unhealthy, so the escrow-release transaction callback had never been executed by a
 * test. These tests run it for real against a fake `tx`, which is how all three bugs
 * stayed hidden:
 *
 *  C-01  a wallet frozen for fraud investigation still had its escrow released the
 *        moment the delivery deadline passed — the callback carried only a `version`
 *        guard, no `isLocked` check, unlike both manual release paths.
 *  C-02  the grace-period marker was read *and written* inside the Prisma transaction,
 *        so a rollback after the write left the marker set while undoing the deadline
 *        extension. The next run read "grace already granted" and auto-completed against
 *        a grace period the buyer never actually received.
 *  C-03  the post-transaction realtime pushes fired unconditionally, so every early
 *        return told the buyer the order was auto-completed and told the seller
 *        "Rp X has been credited to your wallet" while no money had moved.
 */

const SEN = 100n;

type TxOverrides = {
  acceptedProof?: { id: string } | null;
  submittedProof?: { id: string; status: string } | null;
  rejectedProof?: { id: string } | null;
  buyerLocked?: boolean;
  sellerLocked?: boolean;
  orderUpdateCount?: number;
  extensionCount?: number;
  graceMarker?: string | null;
  txThrowsAfterGrace?: boolean;
};

const ORDER = {
  id: 'ord-cuid-1',
  orderId: 'ORD-0001',
  title: 'Jasa desain logo',
  buyerId: 'buyer-1',
  sellerId: 'seller-1',
  status: OrderStatus.IN_DELIVERY,
  deliveryDeadlineAt: new Date(Date.now() - 60 * 60 * 1000),
  buyerPayAmount: 1_000_000n * SEN,
  sellerReceiveAmount: 950_000n * SEN,
  orderValue: 1_000_000n * SEN,
  feeAmount: 0n,
  isKahadePlus: false,
};

describe('AutoCompleteDeliveredOrdersService — escrow release guards', () => {
  let service: AutoCompleteDeliveredOrdersService;
  let prisma: Record<string, any>;
  let redis: Record<string, any>;
  let tx: Record<string, any>;

  function arrange(opts: TxOverrides = {}) {
    const buyerWallet = {
      id: 'w-buyer',
      version: 1,
      isLocked: opts.buyerLocked ?? false,
      escrowBalance: 2_000_000n * SEN,
      availableBalance: 0n,
      totalBalance: 2_000_000n * SEN,
    };
    const sellerWallet = {
      id: 'w-seller',
      version: 1,
      isLocked: opts.sellerLocked ?? false,
      escrowBalance: 0n,
      availableBalance: 100_000n * SEN,
      totalBalance: 100_000n * SEN,
    };

    tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      deliveryProof: {
        findFirst: jest.fn(async ({ where }: any) => {
          const status = where.status;
          if (status === 'ACCEPTED') return opts.acceptedProof !== undefined ? opts.acceptedProof : { id: 'dp-1' };
          if (status === 'SUBMITTED') return opts.submittedProof ?? null;
          return opts.rejectedProof ?? null;
        }),
      },
      order: {
        findUnique: jest.fn().mockResolvedValue({ status: OrderStatus.IN_DELIVERY, deliveryDeadlineAt: ORDER.deliveryDeadlineAt, dispute: null }),
        updateMany: jest.fn(async ({ data }: any) =>
          'status' in data
            ? { count: opts.orderUpdateCount ?? 1 }
            : { count: opts.extensionCount ?? 1 },
        ),
      },
      wallet: {
        findUnique: jest.fn(async ({ where }: any) => {
          if (where.userId === ORDER.buyerId || where.id === buyerWallet.id) return buyerWallet;
          if (where.userId === ORDER.sellerId || where.id === sellerWallet.id) return sellerWallet;
          return null;
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      walletTransaction: {
        create: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue({ amount: ORDER.buyerPayAmount }),
      },
      notification: { create: jest.fn().mockResolvedValue({}) },
      orderStatusHistory: { create: jest.fn().mockResolvedValue({}) },
      user: { update: jest.fn().mockResolvedValue({}) },
      subscription: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    let served = false;
    prisma.order.findMany.mockImplementation(async () => {
      if (served) return [];
      served = true;
      return [ORDER];
    });

    prisma.$transaction.mockImplementation(async (cb: any) => {
      const result = await cb(tx);
      if (opts.txThrowsAfterGrace) throw new Error('serialization failure after grace write');
      return result;
    });

    let cronLockToken: string | undefined;
    redis.setNx.mockImplementation(async (_key: string, token: string) => {
      cronLockToken = token;
      return true;
    });
    redis.get.mockImplementation(async (key: string) =>
      key.startsWith('auto_complete_grace:') ? (opts.graceMarker ?? null) : cronLockToken,
    );

    return { buyerWallet, sellerWallet };
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    prisma = {
      order: { findMany: jest.fn().mockResolvedValue([]) },
      notification: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(),
      emitNotificationCreated: jest.fn(),
    };

    redis = {
      isHealthy: jest.fn().mockResolvedValue(true),
      setNx: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AutoCompleteDeliveredOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
        { provide: WalletTxSerialService, useValue: { getNext: jest.fn().mockResolvedValue(1) } },
        { provide: ReferralService, useValue: { createReferralRewardIfEligible: jest.fn() } },
        { provide: MembershipRankService, useValue: { checkAndUpdateMembershipRank: jest.fn() } },
        { provide: FeeCalculatorService, useValue: { getFeeConfig: jest.fn(), getPlusSavingsSen: jest.fn() } },
      ],
    }).compile();

    service = module.get(AutoCompleteDeliveredOrdersService);
  });

  // C-01
  describe('locked wallets (C-01)', () => {
    it('does NOT move money when the buyer wallet is locked', async () => {
      arrange({ buyerLocked: true });

      await service.autoComplete();

      expect(tx.wallet.updateMany).not.toHaveBeenCalled();
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('does NOT move money when the seller wallet is locked', async () => {
      arrange({ sellerLocked: true });

      await service.autoComplete();

      expect(tx.wallet.updateMany).not.toHaveBeenCalled();
      expect(tx.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('treats a locked wallet as a deferral, not a failure — no failure counter, no CRITICAL', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      arrange({ buyerLocked: true });

      await service.autoComplete();

      // The order must actually have been deferred (logged as such), not silently completed.
      expect(warn.mock.calls.some((c) => String(c[0]).includes('Deferred auto-complete'))).toBe(true);
      // A deliberate freeze must not burn the consecutive-failure budget or page ops.
      expect(redis.incr).not.toHaveBeenCalled();
      expect(error.mock.calls.some((c) => String(c[0]).includes('CRITICAL'))).toBe(false);

      warn.mockRestore();
      error.mockRestore();
    });

    it('sends no completion push when the release was deferred', async () => {
      arrange({ sellerLocked: true });

      await service.autoComplete();

      expect(prisma.emitNotificationCreated).not.toHaveBeenCalled();
    });

    it('releases escrow normally when neither wallet is locked', async () => {
      arrange();

      await service.autoComplete();

      expect(tx.wallet.updateMany).toHaveBeenCalledTimes(2);
      expect(tx.walletTransaction.create).toHaveBeenCalledTimes(2);
    });
  });

  // C-02
  describe('grace-period marker durability (C-02)', () => {
    it('does NOT set the Redis marker when the transaction rolls back after the extension', async () => {
      arrange({
        acceptedProof: null,
        submittedProof: { id: 'dp-sub', status: 'SUBMITTED' },
        txThrowsAfterGrace: true,
      });

      await service.autoComplete();

      expect(redis.setex).not.toHaveBeenCalled();
    });

    it('sets the marker only after the extension commits', async () => {
      arrange({
        acceptedProof: null,
        submittedProof: { id: 'dp-sub', status: 'SUBMITTED' },
      });

      await service.autoComplete();

      expect(redis.setex).toHaveBeenCalledWith(
        `auto_complete_grace:${ORDER.id}`,
        expect.any(Number),
        '1',
      );
      expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    });

    it('performs no Redis read inside the transaction callback', async () => {
      arrange({
        acceptedProof: null,
        submittedProof: { id: 'dp-sub', status: 'SUBMITTED' },
      });
      let readsDuringTx = 0;
      prisma.$transaction.mockImplementation(async (cb: any) => {
        const before = redis.get.mock.calls.length;
        const out = await cb(tx);
        readsDuringTx = redis.get.mock.calls.length - before;
        return out;
      });

      await service.autoComplete();

      expect(readsDuringTx).toBe(0);
    });

    it('auto-completes on the next run once the grace marker is already set', async () => {
      arrange({
        acceptedProof: null,
        submittedProof: { id: 'dp-sub', status: 'SUBMITTED' },
        graceMarker: '1',
      });

      await service.autoComplete();

      expect(tx.wallet.updateMany).toHaveBeenCalledTimes(2);
    });
  });

  // C-03
  describe('post-transaction pushes are gated on the outcome (C-03)', () => {
    it('sends no push when the order has no delivery proof at all', async () => {
      arrange({ acceptedProof: null, submittedProof: null, rejectedProof: null });

      await service.autoComplete();

      expect(prisma.emitNotificationCreated).not.toHaveBeenCalled();
    });

    it('sends no push when only rejected proofs exist', async () => {
      arrange({
        acceptedProof: null,
        submittedProof: null,
        rejectedProof: { id: 'dp-rej' },
      });

      await service.autoComplete();

      expect(prisma.emitNotificationCreated).not.toHaveBeenCalled();
    });

    it('sends no "Funds Received" push when the status changed underneath us', async () => {
      arrange({ orderUpdateCount: 0 });

      await service.autoComplete();

      const titles = prisma.emitNotificationCreated.mock.calls.map((c: any[]) => c[0].title);
      expect(titles).not.toContain('Funds Received');
    });

    it('sends the review reminder — not the completion push — when grace is granted', async () => {
      arrange({
        acceptedProof: null,
        submittedProof: { id: 'dp-sub', status: 'SUBMITTED' },
      });

      await service.autoComplete();

      const titles = prisma.emitNotificationCreated.mock.calls.map((c: any[]) => c[0].title);
      expect(titles).toContain('Segera Review Bukti Pengiriman');
      expect(titles).not.toContain('Funds Received');
      expect(titles).not.toContain('Order Auto-Completed');
    });

    it('sends both completion pushes on a real auto-complete', async () => {
      arrange();

      await service.autoComplete();

      const titles = prisma.emitNotificationCreated.mock.calls.map((c: any[]) => c[0].title);
      expect(titles).toContain('Order Auto-Completed');
      expect(titles).toContain('Funds Received');
    });

    it('clears the failure counter after a successful auto-complete', async () => {
      arrange();

      await service.autoComplete();

      expect(redis.del).toHaveBeenCalledWith(`auto_complete_failures:${ORDER.id}`);
    });
  });
});
