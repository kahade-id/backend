// GAP-C (G176–G200): order escrow bertahap (milestone).
//
// EKSTENSI opt-in dari escrow satu tahap existing. Order tanpa milestone
// memakai alur lama tanpa perubahan perilaku sedikit pun. Semua pergerakan
// dana milestone memakai ledger idempoten + concurrency guard + transaksi DB.
//
// Konvensi satuan: database menyimpan sen (amount rupiah x 100).
// KONTRAK API: semua nominal response milestone dalam IDR (rupiah, integer),
// selaras kontrak order mobile. Input DTO juga dalam IDR (dikonversi ke sen
// via toSen).
// Fee/diskon konsisten per tahap (G187): buyerAmount_i, sellerAmount_i, dan
// feeAmount_i dihitung proporsional (floor, tahap terakhir menyerap sisa)
// sehingga sum-nya sama persis dengan buyerPayAmount / sellerReceiveAmount /
// feeAmount order.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ActorType,
  DisputeInitiator,
  DisputeStatus,
  MilestoneActorType,
  MilestoneEventType,
  MilestoneStatus,
  NotificationType,
  OrderStatus,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
  Prisma,
  WalletTransactionStatus,
  WalletTransactionType,
} from '@prisma/client';
import { toIdr } from '../../common/utils/currency.util';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { generateDisputeId, generateNotifId, generateWalletTxId } from '../../common/utils/id-generator.util';
import { DISPUTE_SLA_HOURS } from '../../common/constants/app.constants';
import * as ErrorCodes from '../../common/constants/error-codes';
import { getCategoryForType } from '../notifications/notification-category.map';
import { PrismaService } from '../../prisma/prisma.service';
import { Optional } from '@nestjs/common';
import { WalletModeService } from '../wallet-mode/wallet-mode.service';
import { EscrowDisbursementService } from '../no-wallet/escrow-disbursement.service';
import { DanaDirectRefundService } from '../no-wallet/dana-direct-refund.service';
import { EscrowDisbursementScope, EscrowDisbursementStatus } from '@prisma/client';
import { activateMilestonesForOrderTx } from './milestone-activation';
import {
  ChangeRequestDto,
  CreateMilestonesDto,
  EvidenceDto,
  ExtendDeadlineDto,
  RevisionDto,
  UpdateMilestoneDto,
} from './dto/milestone.dto';

type Tx = Prisma.TransactionClient;

const REVIEW_WINDOW_MS = 3 * 24 * 60 * 60 * 1000; // 3 hari review buyer (G183)
const MAX_MILESTONES = 20;

/** Rincian split dana per tahap. */
export interface MilestoneSplit {
  amount: bigint;
  buyerAmount: bigint;
  sellerAmount: bigint;
  feeAmount: bigint;
}

/**
 * Bagi buyerPayAmount/sellerReceiveAmount secara proporsional ke tiap tahap.
 * Floor per tahap; tahap terakhir menyerap sisa pembulatan sehingga totalnya
 * pas (invariant G187). feeAmount_i = buyerAmount_i - sellerAmount_i.
 */
export function splitMilestoneFunds(
  amounts: bigint[],
  buyerPayAmount: bigint,
  sellerReceiveAmount: bigint,
): MilestoneSplit[] {
  const total = amounts.reduce((a, b) => a + b, 0n);
  if (total <= 0n) {
    throw new BadRequestException({
      code: ErrorCodes.INVALID_ORDER_STATUS,
      message: 'Total nilai tahap harus lebih dari 0.',
    });
  }
  return amounts.map((amount, i) => {
    const last = i === amounts.length - 1;
    const sellerAmount = last
      ? sellerReceiveAmount - amounts.slice(0, i).reduce((a, amt, j) => a + (sellerReceiveAmount * amt) / total, 0n)
      : (sellerReceiveAmount * amount) / total;
    const buyerAmount = last
      ? buyerPayAmount - amounts.slice(0, i).reduce((a, amt) => a + (buyerPayAmount * amt) / total, 0n)
      : (buyerPayAmount * amount) / total;
    return { amount, buyerAmount, sellerAmount, feeAmount: buyerAmount - sellerAmount };
  });
}

@Injectable()
export class MilestonesService {
  private readonly logger = new Logger(MilestonesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly txSerial: WalletTxSerialService,
    // M5 no-wallet: release via disbursement DANA + refund parsial per tahap.
    @Optional() private readonly walletMode?: WalletModeService | null,
    @Optional() private readonly disbursement?: EscrowDisbursementService | null,
    @Optional() private readonly danaRefund?: DanaDirectRefundService | null,
  ) {}

  /** Kunci idempotensi disbursement per tahap — stabil. */
  private milestoneDisbursementKey(milestoneId: string): string {
    return `MILESTONE:${milestoneId}`;
  }

  /** Kunci idempotensi refund DANA per tahap yang dibatalkan — stabil. */
  private milestoneCancelRefundKey(milestoneId: string): string {
    return `MILESTONE_CANCEL:${milestoneId}`;
  }

  private isNoWalletMode(): boolean {
    return !(this.walletMode?.isWalletEnabled() ?? true);
  }

  /**
   * M5: post-commit best-effort — jalankan settlement disbursement DANA untuk
   * satu tahap. Idempoten (kunci disbursement stabil). Bila proses mati sebelum
   * ini jalan, baris PENDING yang dibuat di dalam tx diambil cron retry.
   * Kegagalan di sini TIDAK me-rollback state (fail-open terkontrol: record
   * durable sudah ada, settlement dapat di-retry).
   */
  private async runPostCommitMilestoneRelease(d: {
    key: string;
    sellerId: string;
    amountSen: bigint;
  }): Promise<void> {
    if (!this.disbursement) {
      this.logger.error(`Post-commit release tahap ${d.key}: disbursement service tidak tersedia`);
      return;
    }
    try {
      const res = await this.disbursement.releaseFunds({
        idempotencyKey: d.key,
        scope: EscrowDisbursementScope.MILESTONE,
        sellerId: d.sellerId,
        amountSen: d.amountSen,
        reason: `Release tahap ${d.key}`,
      });
      if (res.outcome === 'HELD_NO_BANK') {
        this.logger.warn(`Release tahap ${d.key} HELD_NO_BANK — menunggu rekening seller`);
      }
    } catch (e) {
      // Best-effort: baris PENDING durable → cron retry mengambil alih.
      this.logger.error(`Post-commit release tahap ${d.key} gagal: ${(e as Error).message}`);
    }
  }

  // ----------------------------------------------------------------- helpers

  private async assertParty(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderId: true,
        title: true,
        buyerId: true,
        sellerId: true,
        status: true,
        orderValue: true,
        buyerPayAmount: true,
        sellerReceiveAmount: true,
        feeAmount: true,
      },
    });
    if (!order) {
      throw new NotFoundException({ code: 'ORDER_NOT_FOUND', message: 'Order tidak ditemukan.' });
    }
    if (userId !== order.buyerId && userId !== order.sellerId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Hanya pembeli atau penjual order ini yang dapat mengakses milestone.',
      });
    }
    return order;
  }

  private async getMilestoneForParty(milestoneId: string, userId: string) {
    const milestone = await this.prisma.orderMilestone.findUnique({
      where: { id: milestoneId },
      include: { order: true },
    });
    if (!milestone) {
      throw new NotFoundException({ code: 'MILESTONE_NOT_FOUND', message: 'Milestone tidak ditemukan.' });
    }
    if (userId !== milestone.order.buyerId && userId !== milestone.order.sellerId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Hanya pembeli atau penjual order ini yang dapat mengakses milestone.',
      });
    }
    return milestone;
  }

  private roleOf(order: { buyerId: string; sellerId: string }, userId: string): MilestoneActorType {
    if (userId === order.buyerId) return MilestoneActorType.BUYER;
    if (userId === order.sellerId) return MilestoneActorType.SELLER;
    return MilestoneActorType.ADMIN;
  }

  /**
   * SEC-102: aksi milestone (submit/accept) hanya sah bila order induk masih
   * aktif (PROCESSING/IN_DELIVERY). Fail-closed: status lain — termasuk
   * DISPUTED — ditolak agar dana/sengketa tidak bergerak via jalur milestone.
   */
  private assertOrderAllowsMilestoneAction(order: { status: OrderStatus }): void {
    if (order.status !== OrderStatus.PROCESSING && order.status !== OrderStatus.IN_DELIVERY) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Aksi milestone hanya dapat dilakukan saat order berstatus PROCESSING atau IN_DELIVERY.',
      });
    }
  }

  private async recordEvent(
    tx: Tx,
    milestoneId: string,
    actorType: MilestoneActorType,
    eventType: MilestoneEventType,
    actorId?: string,
    payload?: Prisma.InputJsonValue,
  ) {
    await tx.milestoneEvent.create({
      data: { milestoneId, actorType, actorId: actorId ?? null, eventType, payload: payload ?? Prisma.DbNull },
    });
  }

  /** Notifikasi best-effort (tidak menggagalkan transaksi bisnis). */
  private async notifyUser(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    refId: string,
  ) {
    try {
      // NCC-004: actionUrl `/milestones/<id>` agar tap notifikasi (push
      // maupun inbox) membuka detail milestone; milestoneId ikut di payload
      // push (SAFE_PUSH_DATA_KEYS) sebagai fallback derive.
      const actionUrl = `/milestones/${encodeURIComponent(refId)}`;
      await this.prisma.notification.create({
        data: {
          notifId: generateNotifId(),
          userId,
          type,
          category: getCategoryForType(type),
          title,
          body,
          isRead: false,
          refType: 'MILESTONE',
          refId,
          actionUrl,
        },
      });
      this.prisma.emitNotificationCreated({ userId, title, body, data: { type, milestoneId: refId, actionUrl } });
    } catch (err: unknown) {
      this.logger.warn(`silent-catch: milestone notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ------------------------------------------------------------ read (G200)

  /** Daftar milestone sebuah order + ringkasan dana (G193, G200). */
  async getOrderMilestones(orderId: string, userId: string) {
    const order = await this.assertParty(orderId, userId);
    const milestones = await this.prisma.orderMilestone.findMany({
      where: { orderId },
      orderBy: { seq: 'asc' },
      select: {
        id: true,
        seq: true,
        title: true,
        description: true,
        amount: true,
        sellerAmount: true,
        buyerAmount: true,
        feeAmount: true,
        status: true,
        deadline: true,
        reviewDeadline: true,
        submittedAt: true,
        acceptedAt: true,
        releasedAt: true,
        revisionRounds: true,
        maxRevisionRounds: true,
        escrowHeld: true,
        updatedAt: true,
      },
    });
    const toNum = (v: bigint) => toIdr(v); // kontrak API: nominal dalam IDR
    const TERMINAL: MilestoneStatus[] = [MilestoneStatus.RELEASED, MilestoneStatus.CANCELLED];
    const nextPending = [...milestones]
      .filter((m) => !TERMINAL.includes(m.status))
      .sort((a, b) => a.seq - b.seq)[0];
    const rowsWithIdr = milestones.map((m) => ({
      ...m,
      orderId: order.orderId,
      amount: toNum(m.amount),
      sellerAmount: toNum(m.sellerAmount),
      buyerAmount: toNum(m.buyerAmount),
      feeAmount: toNum(m.feeAmount),
      escrowHeld: toNum(m.escrowHeld),
    }));
    return {
      orderId: order.orderId,
      orderStatus: order.status,
      summary: {
        totalAmount: toIdr(order.orderValue),
        totalEscrowHeld: milestones.reduce((a, m) => a + toIdr(m.escrowHeld), 0),
        totalReleased: milestones
          .filter((m) => m.status === MilestoneStatus.RELEASED)
          .reduce((a, m) => a + toIdr(m.sellerAmount), 0),
        releasedCount: milestones.filter((m) => m.status === MilestoneStatus.RELEASED).length,
        totalCount: milestones.length,
        // G191: tahap berikutnya yang belum final (null bila semua final).
        nextPending: nextPending
          ? {
              id: nextPending.id,
              seq: nextPending.seq,
              title: nextPending.title,
              amount: toIdr(nextPending.amount),
              sellerAmount: toIdr(nextPending.sellerAmount),
              status: nextPending.status,
              deadline: nextPending.deadline,
            }
          : null,
      },
      milestones: rowsWithIdr,
    };
  }

  /** Detail satu milestone + timeline + evidence (G193). */
  async getMilestone(milestoneId: string, userId: string) {
    const milestone = await this.getMilestoneForParty(milestoneId, userId);
    const [evidence, events] = await Promise.all([
      this.prisma.milestoneEvidence.findMany({
        where: { milestoneId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, fileKey: true, fileType: true, caption: true, createdAt: true },
      }),
      this.prisma.milestoneEvent.findMany({
        where: { milestoneId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, actorType: true, eventType: true, payload: true, createdAt: true },
      }),
    ]);
    return {
      id: milestone.id,
      orderId: milestone.order.orderId,
      seq: milestone.seq,
      title: milestone.title,
      description: milestone.description,
      amount: toIdr(milestone.amount),
      sellerAmount: toIdr(milestone.sellerAmount),
      buyerAmount: toIdr(milestone.buyerAmount),
      feeAmount: toIdr(milestone.feeAmount),
      status: milestone.status,
      deadline: milestone.deadline,
      reviewDeadline: milestone.reviewDeadline,
      submittedAt: milestone.submittedAt,
      acceptedAt: milestone.acceptedAt,
      releasedAt: milestone.releasedAt,
      revisionRounds: milestone.revisionRounds,
      maxRevisionRounds: milestone.maxRevisionRounds,
      escrowHeld: toIdr(milestone.escrowHeld),
      hasPendingChange: milestone.changeRequest != null,
      // changeRequest JSONB mentah TIDAK diekspos; hanya field yang relevan
      // untuk keputusan dua pihak (tanpa requestedBy internal).
      changeRequest: (() => {
        const cr = milestone.changeRequest as Record<string, unknown> | null;
        if (!cr || typeof cr !== 'object') return null;
        const amt = cr['amountIdr'];
        return {
          title: typeof cr['title'] === 'string' ? cr['title'] : undefined,
          amount: typeof amt === 'number' && Number.isSafeInteger(amt) ? amt : undefined,
          deadline: typeof cr['deadline'] === 'string' ? cr['deadline'] : undefined,
          note: typeof cr['note'] === 'string' ? cr['note'] : undefined,
          requestedAt: typeof cr['requestedAt'] === 'string' ? cr['requestedAt'] : undefined,
        };
      })(),
      buyerApprovedChange: milestone.buyerApprovedChange,
      sellerApprovedChange: milestone.sellerApprovedChange,
      evidence,
      events,
    };
  }

// --------------------------------------------- creation & activation (G176)

  /**
   * Buat rencana milestone untuk sebuah order. Hanya penjual, hanya sebelum
   * order dibayar. Sum(amount) HARUS = orderValue (G177). Status awal DRAFT.
   */
  async createMilestones(orderId: string, sellerId: string, dto: CreateMilestonesDto) {
    const order = await this.assertParty(orderId, sellerId);
    if (sellerId !== order.sellerId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Hanya penjual yang dapat membuat rencana tahap order.',
      });
    }
    if (order.status !== 'WAITING_PAYMENT') {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Rencana tahap hanya dapat dibuat sebelum order dibayar.',
      });
    }
    // Validasi awal (fast-path); yang otoritatif diulang di dalam tx (M5).
    const existing = await this.prisma.orderMilestone.count({ where: { orderId } });
    if (existing > 0) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Order ini sudah memiliki rencana tahap.',
      });
    }
    if (dto.milestones.length > MAX_MILESTONES) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: `Maksimal ${MAX_MILESTONES} tahap per order.`,
      });
    }

    const amounts = dto.milestones.map((m) => BigInt(m.amountIdr) * 100n);
    const totalAmount = amounts.reduce((a, b) => a + b, 0n);
    if (totalAmount !== order.orderValue) {
      throw new BadRequestException({
        code: 'MILESTONE_AMOUNT_MISMATCH',
        message: `Total nilai tahap (${dto.milestones.reduce((a, m) => a + m.amountIdr, 0)}) harus sama persis dengan nilai order.`,
      });
    }

    const splits = splitMilestoneFunds(amounts, order.buyerPayAmount, order.sellerReceiveAmount);

    const result = await this.prisma.$transaction(async (tx) => {
      // M5 (SEC-B ronde 2): validasi status + seller + hitungan milestone
      // dilakukan DI DALAM tx dengan baca ulang — pengecekan di luar tx bisa
      // basi bila payOrder menang balapan: milestone tidak boleh dibuat
      // setelah order dibayar.
      const fresh = await tx.order.findUnique({
        where: { id: order.id },
        select: { sellerId: true, status: true },
      });
      if (!fresh || fresh.sellerId !== sellerId) {
        throw new ForbiddenException({
          code: 'FORBIDDEN',
          message: 'Hanya penjual yang dapat membuat rencana tahap order.',
        });
      }
      if (fresh.status !== 'WAITING_PAYMENT') {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_ORDER_STATUS,
          message: 'Rencana tahap hanya dapat dibuat sebelum order dibayar.',
        });
      }
      const existing = await tx.orderMilestone.count({ where: { orderId } });
      if (existing > 0) {
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Order ini sudah memiliki rencana tahap.',
        });
      }
      const created: { id: string }[] = [];
      for (let i = 0; i < dto.milestones.length; i++) {
        const item = dto.milestones[i];
        const split = splits[i];
        const m = await tx.orderMilestone.create({
          data: {
            orderId,
            seq: i + 1,
            title: item.title,
            description: item.description ?? null,
            amount: split.amount,
            sellerAmount: split.sellerAmount,
            buyerAmount: split.buyerAmount,
            feeAmount: split.feeAmount,
            status: MilestoneStatus.DRAFT,
            deadline: item.deadline ? new Date(item.deadline) : null,
            maxRevisionRounds: item.maxRevisionRounds ?? 2,
          },
          select: { id: true },
        });
        await this.recordEvent(tx, m.id, MilestoneActorType.SELLER, MilestoneEventType.CREATED, sellerId, {
          seq: i + 1,
          title: item.title,
        } as Prisma.InputJsonValue);
        created.push(m);
      }
      return created;
    });

    await this.notifyUser(
      order.buyerId,
      NotificationType.MILESTONE_SUBMITTED,
      'Rencana Tahap Order',
      `Penjual membuat rencana ${result.length} tahap untuk order "${order.title}".`,
      result[0].id,
    );
    return { orderId: order.orderId, count: result.length, milestoneIds: result.map((m) => m.id) };
  }

  /**
   * Hook yang dipanggil tepat SETELAH escrow order berhasil di-lock saat
   * pembayaran (G176). Mengaktifkan semua milestone DRAFT: status →
   * AWAITING_ACTIVATION dan escrowHeld = buyerAmount_i.
   *
   * Idempoten: bila milestone sudah aktif, tidak melakukan apa-apa.
   * Order tanpa milestone → no-op (alur satu tahap tidak berubah).
   */
  async activateMilestonesForOrder(tx: Tx, orderId: string) {
    // Mendelegasikan ke fungsi murni agar dapat dipakai jalur wallet maupun
    // QRIS tanpa circular dependency. Idempoten; no-op untuk order tanpa milestone.
    const { activated } = await activateMilestonesForOrderTx(tx, orderId);
    if (activated > 0) {
      this.logger.log(`Activated ${activated} milestones for order ${orderId}`);
    }
    return { activated };
  }

  // ---------------------------------------------------- update & changes (G178/G179)

  /**
   * Ubah detail tahap (seller). Langsung bila DRAFT; pasca-aktivasi hanya
   * via change request dua pihak. amount TIDAK dapat diubah di sini — hanya
   * lewat changeRequest yang disetujui dua pihak (dan hanya pre-aktivasi).
   */
  async updateMilestone(milestoneId: string, sellerId: string, dto: UpdateMilestoneDto) {
    const milestone = await this.getMilestoneForParty(milestoneId, sellerId);
    if (sellerId !== milestone.order.sellerId) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya penjual yang dapat mengubah tahap.' });
    }
    if (milestone.status !== MilestoneStatus.DRAFT) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Tahap yang sudah aktif hanya dapat diubah lewat persetujuan dua pihak (change request).',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.orderMilestone.update({
        where: { id: milestoneId },
        data: {
          title: dto.title ?? undefined,
          description: dto.description ?? undefined,
          deadline: dto.deadline ? new Date(dto.deadline) : undefined,
          maxRevisionRounds: dto.maxRevisionRounds ?? undefined,
        },
      });
      await this.recordEvent(tx, milestoneId, MilestoneActorType.SELLER, MilestoneEventType.UPDATED, sellerId);
    });
    return { id: milestoneId };
  }

  /**
   * Ajukan perubahan tahap (G179). Perubahan amount hanya diizinkan saat
   * DRAFT; pasca-aktivasi amount terkunci agar invariant escrow tidak rusak.
   * Pengaju otomatis menyetujui pihaknya sendiri.
   */
  async requestChange(milestoneId: string, userId: string, dto: ChangeRequestDto) {
    const milestone = await this.getMilestoneForParty(milestoneId, userId);
    const order = milestone.order;
    const role = this.roleOf(order, userId);
    if (role !== MilestoneActorType.BUYER && role !== MilestoneActorType.SELLER) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya pihak order yang dapat mengajukan perubahan.' });
    }
    if (milestone.status === MilestoneStatus.RELEASED || milestone.status === MilestoneStatus.CANCELLED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Tahap yang sudah selesai/dibatalkan tidak dapat diubah.',
      });
    }
    if (milestone.changeRequest) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Sudah ada pengajuan perubahan yang menunggu persetujuan.',
      });
    }
    const change = dto.change as Record<string, unknown>;
    const allowedKeys = ['title', 'description', 'deadline', 'maxRevisionRounds', 'amountIdr'];
    for (const k of Object.keys(change)) {
      if (!allowedKeys.includes(k)) {
        throw new BadRequestException({
          code: ErrorCodes.INVALID_ORDER_STATUS,
          message: `Perubahan "${k}" tidak didukung.`,
        });
      }
    }
    if (change['amountIdr'] !== undefined && milestone.status !== MilestoneStatus.DRAFT) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Nilai tahap tidak dapat diubah setelah tahap aktif (menjaga invariant escrow).',
      });
    }
    const isBuyer = role === MilestoneActorType.BUYER;
    await this.prisma.$transaction(async (tx) => {
      await tx.orderMilestone.update({
        where: { id: milestoneId },
        data: {
          changeRequest: { change, note: dto.note ?? null, requestedBy: userId, requestedAt: new Date().toISOString() } as Prisma.InputJsonValue,
          buyerApprovedChange: isBuyer,
          sellerApprovedChange: !isBuyer,
        },
      });
      await this.recordEvent(tx, milestoneId, role, MilestoneEventType.CHANGE_REQUESTED, userId, {
        change,
      } as Prisma.InputJsonValue);
    });
    const otherPartyId = isBuyer ? order.sellerId : order.buyerId;
    await this.notifyUser(
      otherPartyId,
      NotificationType.MILESTONE_SUBMITTED,
      'Pengajuan Perubahan Tahap',
      `${isBuyer ? 'Pembeli' : 'Penjual'} mengajukan perubahan tahap ${milestone.seq} order "${order.title}". Mohon tinjau.`,
      milestoneId,
    );
    return { id: milestoneId, needsApprovalFrom: isBuyer ? 'SELLER' : 'BUYER' };
  }

  /**
   * Setujui perubahan tahap. Bila kedua pihak setuju → terapkan (G179).
   * Perubahan amount memicu validasi ulang total = orderValue + hitung ulang split.
   */
  async approveChange(milestoneId: string, userId: string) {
    const milestone = await this.getMilestoneForParty(milestoneId, userId);
    const order = milestone.order;
    const role = this.roleOf(order, userId);
    if (role !== MilestoneActorType.BUYER && role !== MilestoneActorType.SELLER) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya pihak order yang dapat menyetujui.' });
    }
    const cr = milestone.changeRequest as unknown as {
      change: Record<string, unknown>;
      note: string | null;
      requestedBy: string;
      requestedAt: string;
    } | null;
    if (!cr) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Tidak ada pengajuan perubahan yang menunggu.',
      });
    }
    if (cr.requestedBy === userId) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Pengaju tidak dapat menyetujui pengajuannya sendiri.',
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const isBuyer = role === MilestoneActorType.BUYER;
      const updated = await tx.orderMilestone.update({
        where: { id: milestoneId },
        data: { buyerApprovedChange: isBuyer ? true : undefined, sellerApprovedChange: !isBuyer ? true : undefined },
      });
      if (updated.buyerApprovedChange && updated.sellerApprovedChange) {
        // Terapkan perubahan.
        const change = cr.change;
        const data: Prisma.OrderMilestoneUpdateInput = {
          changeRequest: Prisma.DbNull,
          buyerApprovedChange: false,
          sellerApprovedChange: false,
        };
        if (change['title'] !== undefined) data.title = String(change['title']);
        if (change['description'] !== undefined) data.description = String(change['description']);
        if (change['deadline'] !== undefined) data.deadline = new Date(String(change['deadline']));
        if (change['maxRevisionRounds'] !== undefined) data.maxRevisionRounds = Number(change['maxRevisionRounds']);
        if (change['amountIdr'] !== undefined) {
          // Hanya DRAFT (dijamin di requestChange). Validasi ulang total.
          const siblings = await tx.orderMilestone.findMany({
            where: { orderId: milestone.orderId, NOT: { id: milestoneId } },
            select: { amount: true },
          });
          const newAmount = BigInt(Math.trunc(Number(change['amountIdr']))) * 100n;
          const total = siblings.reduce((a, s) => a + s.amount, 0n) + newAmount;
          if (total !== order.orderValue) {
            throw new BadRequestException({
              code: 'MILESTONE_AMOUNT_MISMATCH',
              message: 'Total nilai tahap setelah perubahan harus sama persis dengan nilai order.',
            });
          }
          const all = [...siblings.map((s) => s.amount), newAmount];
          const splits = splitMilestoneFunds(all, order.buyerPayAmount, order.sellerReceiveAmount);
          const self = splits[splits.length - 1];
          data.amount = self.amount;
          data.buyerAmount = self.buyerAmount;
          data.sellerAmount = self.sellerAmount;
          data.feeAmount = self.feeAmount;
        }
        await tx.orderMilestone.update({ where: { id: milestoneId }, data });
        await this.recordEvent(tx, milestoneId, role, MilestoneEventType.CHANGE_APPROVED, userId, {
          applied: cr.change,
        } as Prisma.InputJsonValue);
      }
    });
    return { id: milestoneId };
  }

  /** Perpanjang deadline via mekanisme change request dua pihak (G182). */
  async extendDeadline(milestoneId: string, userId: string, dto: ExtendDeadlineDto) {
    const milestone = await this.getMilestoneForParty(milestoneId, userId);
    const newDeadline = new Date(dto.newDeadline);
    if (Number.isNaN(newDeadline.getTime()) || newDeadline <= new Date()) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Deadline baru harus tanggal valid di masa depan.',
      });
    }
    if (milestone.status === MilestoneStatus.DRAFT) {
      // Pre-aktivasi: penjual boleh langsung (belum ada dana bergerak).
      if (userId !== milestone.order.sellerId) {
        throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya penjual yang dapat mengubah deadline draf.' });
      }
      await this.prisma.orderMilestone.update({ where: { id: milestoneId }, data: { deadline: newDeadline } });
      await this.prisma.$transaction(async (tx) => {
        await this.recordEvent(tx, milestoneId, MilestoneActorType.SELLER, MilestoneEventType.DEADLINE_EXTENDED, userId, {
          newDeadline: dto.newDeadline,
        } as Prisma.InputJsonValue);
      });
      return { id: milestoneId, direct: true };
    }
    return this.requestChange(milestoneId, userId, {
      change: { deadline: dto.newDeadline },
      note: dto.reason ?? 'Perpanjangan deadline',
    });
  }

  // ------------------------------------------------ submit / evidence (G180)

  /**
   * Seller menyerahkan hasil tahap (G180). Evidence tercatat sebagai bukti
   * (G181). Status → SUBMITTED, reviewDeadline = +3 hari.
   */
  async submitMilestone(milestoneId: string, sellerId: string) {
    const milestone = await this.getMilestoneForParty(milestoneId, sellerId);
    if (sellerId !== milestone.order.sellerId) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya penjual yang dapat menyerahkan tahap.' });
    }
    // SEC-102: order DISPUTED/non-aktif tidak boleh ada pergerakan milestone.
    this.assertOrderAllowsMilestoneAction(milestone.order);
    if (milestone.status !== MilestoneStatus.AWAITING_ACTIVATION && milestone.status !== MilestoneStatus.REVISION_REQUESTED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Tahap hanya dapat diserahkan dari status menunggu pengerjaan / revisi.',
      });
    }
    const reviewDeadline = new Date(Date.now() + REVIEW_WINDOW_MS);
    await this.prisma.$transaction(async (tx) => {
      const upd = await tx.orderMilestone.updateMany({
        where: { id: milestoneId, status: milestone.status },
        data: { status: MilestoneStatus.SUBMITTED, submittedAt: new Date(), submittedById: sellerId, reviewDeadline },
      });
      if (upd.count === 0) {
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Status tahap berubah bersamaan, silakan muat ulang.',
        });
      }
      await this.recordEvent(tx, milestoneId, MilestoneActorType.SELLER, MilestoneEventType.SUBMITTED, sellerId, {
        reviewDeadline: reviewDeadline.toISOString(),
      } as Prisma.InputJsonValue);
    });
    await this.notifyUser(
      milestone.order.buyerId,
      NotificationType.MILESTONE_SUBMITTED,
      'Tahap Diserahkan',
      `Penjual menyerahkan tahap ${milestone.seq} "${milestone.title}". Mohon tinjau dalam 3 hari.`,
      milestoneId,
    );
    return { id: milestoneId, reviewDeadline };
  }

  /** Tambah bukti pengerjaan tahap (G181). */
  async addEvidence(milestoneId: string, userId: string, dto: EvidenceDto) {
    const milestone = await this.getMilestoneForParty(milestoneId, userId);
    if (milestone.status === MilestoneStatus.RELEASED || milestone.status === MilestoneStatus.CANCELLED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Tahap yang sudah selesai/dibatalkan tidak dapat ditambah bukti.',
      });
    }
    const count = await this.prisma.milestoneEvidence.count({ where: { milestoneId } });
    if (count >= 20) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Maksimal 20 bukti per tahap.',
      });
    }
    const ev = await this.prisma.milestoneEvidence.create({
      data: {
        milestoneId,
        fileKey: dto.fileKey,
        fileType: dto.fileType ?? null,
        caption: dto.caption ?? null,
        uploadedById: userId,
      },
      select: { id: true },
    });
    return { id: ev.id, milestoneId };
  }

  // ---------------------------------------------------- revision / accept (G183/G184)

  /**
   * Buyer meminta revisi (G183). Dibatasi maxRevisionRounds (G200 negatif).
   */
  async requestRevision(milestoneId: string, buyerId: string, dto: RevisionDto) {
    const milestone = await this.getMilestoneForParty(milestoneId, buyerId);
    if (buyerId !== milestone.order.buyerId) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya pembeli yang dapat meminta revisi.' });
    }
    if (milestone.status !== MilestoneStatus.SUBMITTED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Revisi hanya dapat diminta untuk tahap yang sudah diserahkan.',
      });
    }
    if (milestone.revisionRounds >= milestone.maxRevisionRounds) {
      throw new BadRequestException({
        code: 'MILESTONE_REVISION_LIMIT',
        message: `Batas revisi tercapai (${milestone.maxRevisionRounds}x).`,
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const upd = await tx.orderMilestone.updateMany({
        where: { id: milestoneId, status: MilestoneStatus.SUBMITTED },
        data: { status: MilestoneStatus.REVISION_REQUESTED, revisionRounds: { increment: 1 } },
      });
      if (upd.count === 0) {
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Status tahap berubah bersamaan, silakan muat ulang.',
        });
      }
      await this.recordEvent(tx, milestoneId, MilestoneActorType.BUYER, MilestoneEventType.REVISION_REQUESTED, buyerId, {
        note: dto.note ?? null,
        round: milestone.revisionRounds + 1,
      } as Prisma.InputJsonValue);
    });
    await this.notifyUser(
      milestone.order.sellerId,
      NotificationType.MILESTONE_REVISION_REQUESTED,
      'Revisi Diminta',
      `Pembeli meminta revisi tahap ${milestone.seq} "${milestone.title}".`,
      milestoneId,
    );
    return { id: milestoneId, revisionRound: milestone.revisionRounds + 1 };
  }

  /**
   * Buyer menerima tahap → release dana atomik (G184/G186).
   * Concurrency guard: hanya SATU transisi SUBMITTED → ACCEPTED yang lolos;
   * release idempoten via releasedTxId + cek ledger (G200).
   */
  async acceptMilestone(milestoneId: string, buyerId: string) {
    const milestone = await this.getMilestoneForParty(milestoneId, buyerId);
    if (buyerId !== milestone.order.buyerId) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya pembeli yang dapat menerima tahap.' });
    }
    // SEC-102: order DISPUTED/non-aktif tidak boleh ada pencairan via milestone.
    this.assertOrderAllowsMilestoneAction(milestone.order);
    if (milestone.status !== MilestoneStatus.SUBMITTED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Hanya tahap yang sudah diserahkan yang dapat diterima.',
      });
    }

    const released = await this.prisma.$transaction(async (tx) => {
      const upd = await tx.orderMilestone.updateMany({
        where: { id: milestoneId, status: MilestoneStatus.SUBMITTED },
        data: { status: MilestoneStatus.ACCEPTED, acceptedAt: new Date() },
      });
      if (upd.count === 0) {
        throw new ConflictException({
          code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
          message: 'Tahap sudah diproses (kemungkinan accept ganda).',
        });
      }
      await this.recordEvent(tx, milestoneId, MilestoneActorType.BUYER, MilestoneEventType.ACCEPTED, buyerId);
      return this.releaseMilestoneFunds(tx, milestoneId, buyerId);
    });

    // M5: settlement DANA post-commit (best-effort; baris PENDING durable
    // sudah dibuat di dalam tx bila mode tanpa-wallet).
    if (!released.skipped && 'danaDisbursement' in released && released.danaDisbursement) {
      await this.runPostCommitMilestoneRelease(released.danaDisbursement);
    }

    const noWallet = this.isNoWalletMode();
    await this.notifyUser(
      milestone.order.sellerId,
      NotificationType.MILESTONE_RELEASED,
      'Dana Tahap Cair',
      noWallet
        ? `Tahap ${milestone.seq} "${milestone.title}" diterima pembeli. Dana dicairkan ke rekening bank terdaftar Anda.`
        : `Tahap ${milestone.seq} "${milestone.title}" diterima pembeli. Dana telah dicairkan ke wallet Anda.`,
      milestoneId,
    );
    return { id: milestoneId, releasedTxId: released.releasedTxId };
  }

  /**
   * INTI KEUANGAN (G186/G187): cairkan dana satu tahap secara atomik.
   * Idempoten: bila releasedTxId sudah terisi → kembalikan tanpa gerakan dana.
   * Concurrency guard: updateMany where status=ACCEPTED.
   */
  private async releaseMilestoneFunds(tx: Tx, milestoneId: string, actorId: string) {
    // M5 (mode tanpa-wallet): cabang DANA — tanpa sentuh wallet.
    if (this.isNoWalletMode()) {
      return this.releaseMilestoneFundsNoWallet(tx, milestoneId, actorId);
    }
    const milestone = await tx.orderMilestone.findUniqueOrThrow({
      where: { id: milestoneId },
      include: { order: true },
    });
    const order = milestone.order;

    // Idempotensi: sudah pernah release → no-op aman.
    if (milestone.releasedTxId) {
      this.logger.warn(`Idempotent release skip for milestone ${milestoneId} (tx ${milestone.releasedTxId})`);
      return { releasedTxId: milestone.releasedTxId, skipped: true as const };
    }
    const priorLedger = await tx.walletTransaction.findFirst({
      where: { type: WalletTransactionType.MILESTONE_RELEASE, metadata: { path: ['milestoneId'], equals: milestoneId } },
      select: { id: true },
    });
    if (priorLedger) {
      throw new ConflictException({
        code: 'MILESTONE_ALREADY_RELEASED',
        message: 'Dana tahap ini sudah dicairkan (ledger tercatat).',
      });
    }

    if (milestone.status !== MilestoneStatus.ACCEPTED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Hanya tahap berstatus ACCEPTED yang dapat dicairkan.',
      });
    }
    if (milestone.escrowHeld < milestone.buyerAmount) {
      throw new ConflictException({
        code: 'MILESTONE_INVARIANT_VIOLATION',
        message: 'Invariant escrow tahap rusak: escrowHeld lebih kecil dari buyerAmount.',
      });
    }

    const buyerWallet = await tx.wallet.findFirst({ where: { userId: order.buyerId } });
    const sellerWallet = await tx.wallet.findFirst({ where: { userId: order.sellerId } });
    if (!buyerWallet || !sellerWallet) {
      throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet pihak order tidak ditemukan.' });
    }
    if (buyerWallet.isLocked || sellerWallet.isLocked) {
      throw new BadRequestException({ code: 'WALLET_LOCKED', message: 'Wallet terkunci, release tahap dibatalkan.' });
    }
    if (buyerWallet.escrowBalance < milestone.buyerAmount) {
      throw new ConflictException({
        code: 'MILESTONE_INVARIANT_VIOLATION',
        message: 'Saldo escrow buyer tidak mencukupi untuk release tahap ini.',
      });
    }

    const buyerEscrowBefore = buyerWallet.escrowBalance;
    const buyerEscrowAfter = buyerEscrowBefore - milestone.buyerAmount;
    const sellerAvailBefore = sellerWallet.availableBalance;
    const sellerAvailAfter = sellerAvailBefore + milestone.sellerAmount;

    const buyerUpdated = await tx.wallet.updateMany({
      where: { id: buyerWallet.id, version: buyerWallet.version, escrowBalance: { gte: milestone.buyerAmount } },
      data: {
        escrowBalance: { decrement: milestone.buyerAmount },
        totalBalance: { decrement: milestone.buyerAmount },
        version: { increment: 1 },
      },
    });
    if (buyerUpdated.count === 0) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Concurrent wallet update pada buyer, silakan coba lagi.',
      });
    }
    const sellerUpdated = await tx.wallet.updateMany({
      where: { id: sellerWallet.id, version: sellerWallet.version },
      data: {
        availableBalance: { increment: milestone.sellerAmount },
        totalBalance: { increment: milestone.sellerAmount },
        version: { increment: 1 },
      },
    });
    if (sellerUpdated.count === 0) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Concurrent wallet update pada seller, silakan coba lagi.',
      });
    }

    const meta = { milestoneId, orderDbId: order.id, orderPublicId: order.orderId, seq: milestone.seq } as Prisma.InputJsonValue;

    const releaseTxId = generateWalletTxId(await this.txSerial.getNext());
    await tx.walletTransaction.create({
      data: {
        txId: releaseTxId,
        walletId: buyerWallet.id,
        type: WalletTransactionType.MILESTONE_RELEASE,
        status: WalletTransactionStatus.SUCCESS,
        amount: milestone.buyerAmount,
        balanceBefore: buyerEscrowBefore,
        balanceAfter: buyerEscrowAfter,
        orderId: order.id,
        metadata: meta,
        description: `Escrow released for milestone ${milestone.seq} of order ${order.orderId}`,
      },
    });
    const receiveTxId = generateWalletTxId(await this.txSerial.getNext());
    await tx.walletTransaction.create({
      data: {
        txId: receiveTxId,
        walletId: sellerWallet.id,
        type: WalletTransactionType.MILESTONE_RELEASE,
        status: WalletTransactionStatus.SUCCESS,
        amount: milestone.sellerAmount,
        balanceBefore: sellerAvailBefore,
        balanceAfter: sellerAvailAfter,
        orderId: order.id,
        metadata: meta,
        description: `Payment received for milestone ${milestone.seq} of order ${order.orderId}`,
      },
    });

    // Fee platform per tahap (G187) — konsisten dengan FEE_DEDUCT order satu tahap.
    if (milestone.feeAmount > 0n) {
      const feeTxId = generateWalletTxId(await this.txSerial.getNext());
      await tx.walletTransaction.create({
        data: {
          txId: feeTxId,
          walletId: buyerWallet.id,
          type: WalletTransactionType.FEE_DEDUCT,
          status: WalletTransactionStatus.SUCCESS,
          amount: milestone.feeAmount,
          balanceBefore: buyerWallet.totalBalance,
          balanceAfter: buyerWallet.totalBalance - milestone.feeAmount,
          orderId: order.id,
          metadata: meta,
          description: `Platform fee for milestone ${milestone.seq} of order ${order.orderId}`,
        },
      });
    }

    // Concurrency guard terakhir: hanya satu yang boleh menandai RELEASED.
    const marked = await tx.orderMilestone.updateMany({
      where: { id: milestoneId, status: MilestoneStatus.ACCEPTED, releasedTxId: null },
      data: { status: MilestoneStatus.RELEASED, releasedAt: new Date(), releasedTxId: releaseTxId, escrowHeld: 0n },
    });
    if (marked.count === 0) {
      // Race ekstrem: ledger sudah ditulis tapi penanda gagal — jangan tulis
      // ledger ganda; lempar agar transaksi rollback penuh.
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Tahap sudah dicairkan oleh proses lain.',
      });
    }
    await this.recordEvent(tx, milestoneId, MilestoneActorType.SYSTEM, MilestoneEventType.RELEASED, actorId, {
      releasedTxId: releaseTxId,
      buyerAmount: milestone.buyerAmount.toString(),
      sellerAmount: milestone.sellerAmount.toString(),
      feeAmount: milestone.feeAmount.toString(),
    } as Prisma.InputJsonValue);

    // Finalisasi order bila semua tahap sudah terminal (tanpa release legacy).
    await this.maybeFinalizeMilestoneOrder(tx, order.id);

    return { releasedTxId: releaseTxId, skipped: false as const };
  }

  /**
   * M5 (mode tanpa-wallet): cairkan dana satu tahap via disbursement DANA
   * ke rekening bank seller (scope MILESTONE).
   *
   * Desain durable (fail-closed):
   * - Di DALAM tx: tandai tahap RELEASED + buat baris escrowDisbursement
   *   PENDING (kunci `MILESTONE:<milestoneId>`) + event RELEASED. Bila proses
   *   mati setelah commit, cron retry mengambil baris PENDING ini.
   * - SETELAH commit: caller menjalankan post-commit best-effort
   *   `EscrowDisbursementService.releaseFunds()` (idempoten).
   * - Seller menerima tepat `sellerAmount`; fee platform (buyerAmount -
   *   sellerAmount) TETAP di merchant DANA, tidak ikut dicairkan.
   * - Verifikasi rekening (exact normalized account-name match) + hold
   *   HELD_NO_BANK bila seller belum punya rekening primer — semua ditangani
   *   EscrowDisbursementService.
   *
   * Idempoten: releasedTxId terisi → skip; kunci disbursement unik mencegah
   * baris ganda; updateMany ber-guard status.
   */
  private async releaseMilestoneFundsNoWallet(tx: Tx, milestoneId: string, actorId: string) {
    const milestone = await tx.orderMilestone.findUniqueOrThrow({
      where: { id: milestoneId },
      include: { order: true },
    });
    const order = milestone.order;

    // Idempotensi: sudah pernah release → no-op aman.
    if (milestone.releasedTxId) {
      this.logger.warn(`Idempotent no-wallet release skip for milestone ${milestoneId} (tx ${milestone.releasedTxId})`);
      return { releasedTxId: milestone.releasedTxId, skipped: true as const };
    }

    if (milestone.status !== MilestoneStatus.ACCEPTED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Hanya tahap berstatus ACCEPTED yang dapat dicairkan.',
      });
    }
    if (milestone.escrowHeld < milestone.buyerAmount) {
      throw new ConflictException({
        code: 'MILESTONE_INVARIANT_VIOLATION',
        message: 'Invariant escrow tahap rusak: escrowHeld lebih kecil dari buyerAmount.',
      });
    }
    // Invariant fee: seller tidak boleh menerima lebih dari yang dibayar buyer;
    // fee platform = buyerAmount - sellerAmount tertahan di merchant DANA.
    if (milestone.sellerAmount <= 0n || milestone.sellerAmount > milestone.buyerAmount) {
      throw new ConflictException({
        code: 'MILESTONE_INVARIANT_VIOLATION',
        message: 'Invariant nominal tahap rusak: sellerAmount harus dalam (0, buyerAmount].',
      });
    }
    if (!this.disbursement) {
      throw new ServiceUnavailableException({
        code: 'NO_WALLET_PROVIDER_UNAVAILABLE',
        message: 'Layanan disbursement DANA tidak tersedia — release tahap ditahan (fail-closed).',
      });
    }

    // Baris disbursement durable (PENDING) — ditemukan cron retry bila
    // post-commit tidak sempat jalan.
    const disbKey = this.milestoneDisbursementKey(milestoneId);
    const existingDisb = await tx.escrowDisbursement.findUnique({
      where: { idempotencyKey: disbKey },
      select: { id: true, status: true },
    });
    if (!existingDisb) {
      await tx.escrowDisbursement.create({
        data: {
          idempotencyKey: disbKey,
          scope: EscrowDisbursementScope.MILESTONE,
          scopeRefId: milestone.id,
          orderId: order.id,
          sellerId: order.sellerId,
          amountSen: milestone.sellerAmount,
          status: EscrowDisbursementStatus.PENDING,
        },
      });
    }

    // Concurrency guard: hanya satu yang boleh menandai RELEASED.
    const releasedTxId = `DANA:${disbKey}`;
    const marked = await tx.orderMilestone.updateMany({
      where: { id: milestoneId, status: MilestoneStatus.ACCEPTED, releasedTxId: null },
      data: { status: MilestoneStatus.RELEASED, releasedAt: new Date(), releasedTxId, escrowHeld: 0n },
    });
    if (marked.count === 0) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Tahap sudah dicairkan oleh proses lain.',
      });
    }
    await this.recordEvent(tx, milestoneId, MilestoneActorType.SYSTEM, MilestoneEventType.RELEASED, actorId, {
      releasedTxId,
      disbursementKey: disbKey,
      buyerAmount: milestone.buyerAmount.toString(),
      sellerAmount: milestone.sellerAmount.toString(),
      feeAmount: (milestone.buyerAmount - milestone.sellerAmount).toString(),
      noWallet: true,
    } as Prisma.InputJsonValue);

    // Finalisasi order bila semua tahap sudah terminal (tanpa release legacy).
    await this.maybeFinalizeMilestoneOrder(tx, order.id);

    return {
      releasedTxId,
      skipped: false as const,
      danaDisbursement: { key: disbKey, sellerId: order.sellerId, amountSen: milestone.sellerAmount },
    };
  }

  /**
   * Finalisasi order bermilestone (G176): bila SEMUA tahap sudah terminal
   * (RELEASED/CANCELLED), tandai order COMPLETED (bila ada yang released) atau
   * CANCELLED (bila semua dibatalkan) + orderStatusHistory.
   *
   * TIDAK ADA pergerakan dana di sini — dana sudah bergerak per tahap via
   * releaseMilestoneFunds / cancelRemaining. Ini yang membedakannya dari
   * completeOrder() legacy.
   */
  private async maybeFinalizeMilestoneOrder(tx: Tx, orderDbId: string) {
    const order = await tx.order.findUnique({
      where: { id: orderDbId },
      select: { id: true, orderId: true, status: true },
    });
    if (!order) return;
    const ACTIVE: OrderStatus[] = [OrderStatus.PROCESSING, OrderStatus.IN_DELIVERY];
    if (!ACTIVE.includes(order.status)) return;
    const counts = await tx.orderMilestone.groupBy({
      by: ['status'],
      where: { orderId: orderDbId },
      _count: { _all: true },
    });
    const total = counts.reduce((a, c) => a + c._count._all, 0);
    if (total === 0) return; // bukan order milestone — jangan sentuh
    const open = counts.some(
      (c) => c.status !== MilestoneStatus.RELEASED && c.status !== MilestoneStatus.CANCELLED,
    );
    if (open) return;
    const releasedCount = counts.find((c) => c.status === MilestoneStatus.RELEASED)?._count._all ?? 0;
    const target = releasedCount > 0 ? OrderStatus.COMPLETED : OrderStatus.CANCELLED;
    const updated = await tx.order.updateMany({
      where: { id: orderDbId, status: { in: ACTIVE } },
      data: {
        status: target,
        ...(target === OrderStatus.COMPLETED ? { completedAt: new Date() } : {}),
      },
    });
    if (updated.count === 0) return;
    await tx.orderStatusHistory.create({
      data: {
        orderId: orderDbId,
        fromStatus: order.status,
        toStatus: target,
        changedBy: 'system',
        changedByType: ActorType.SYSTEM,
      },
    });
    this.logger.log(
      `Order ${order.orderId} difinalisasi ke ${target}: semua ${total} tahap terminal, tanpa release escrow tambahan.`,
    );
  }

  /**
   * Endpoint retry idempoten (G186): bila tahap ACCEPTED tapi release belum
   * tercatat (mis. crash setelah accept), panggil ulang dengan aman.
   */
  async releaseMilestone(milestoneId: string, userId: string) {
    const milestone = await this.getMilestoneForParty(milestoneId, userId);
    if (milestone.status === MilestoneStatus.RELEASED) {
      return { id: milestoneId, releasedTxId: milestone.releasedTxId, alreadyReleased: true };
    }
    if (milestone.status !== MilestoneStatus.ACCEPTED) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Hanya tahap berstatus ACCEPTED yang dapat dicairkan.',
      });
    }
    // SEC-102: pencairan tahap juga di-guard status order — ACCEPTED yang
    // order-nya DISPUTED tidak boleh cair via retry publik.
    this.assertOrderAllowsMilestoneAction(milestone.order);
    const result = await this.prisma.$transaction((tx) => this.releaseMilestoneFunds(tx, milestoneId, userId));
    // M5: re-drive settlement DANA post-commit (idempoten).
    if (!result.skipped && 'danaDisbursement' in result && result.danaDisbursement) {
      await this.runPostCommitMilestoneRelease(result.danaDisbursement);
    }
    return { id: milestoneId, releasedTxId: result.releasedTxId, alreadyReleased: false };
  }

  /**
   * M5: re-drive settlement disbursement DANA untuk tahap yang sudah RELEASED
   * via kunci DANA (mis. crash setelah commit sebelum post-commit jalan, atau
   * HELD_NO_BANK yang rekeningnya baru ditambahkan). Idempoten.
   */
  async redriveMilestoneDisbursement(milestoneId: string, userId: string) {
    const milestone = await this.getMilestoneForParty(milestoneId, userId);
    if (this.isNoWalletMode()) {
      const m = await this.prisma.orderMilestone.findUniqueOrThrow({ where: { id: milestoneId } });
      if (m.status === MilestoneStatus.RELEASED && m.releasedTxId?.startsWith('DANA:')) {
        const disb = await this.prisma.escrowDisbursement.findUnique({
          where: { idempotencyKey: this.milestoneDisbursementKey(milestoneId) },
        });
        if (disb) {
          await this.runPostCommitMilestoneRelease({
            key: disb.idempotencyKey,
            sellerId: disb.sellerId,
            amountSen: disb.amountSen,
          });
          return { id: milestoneId, redriven: true };
        }
      }
    }
    return { id: milestoneId, redriven: false };
  }

  // ------------------------------------------------- dispute / cancel (G189/G190)

  /**
   * Buka sengketa untuk SATU tahap (G190). Sengketa memakai slot dispute
   * order (orderId unik); milestone lain tidak terpengaruh statusnya.
   * Implementasi minimal: tandai tahap DISPUTED + catat event; resolusi
   * sengketa penuh ditangani modul disputes existing via milestoneId.
   */
  async openMilestoneDispute(milestoneId: string, userId: string, reason: string) {
    const milestone = await this.getMilestoneForParty(milestoneId, userId);
    const order = milestone.order;
    if (
      milestone.status !== MilestoneStatus.SUBMITTED &&
      milestone.status !== MilestoneStatus.REVISION_REQUESTED &&
      milestone.status !== MilestoneStatus.AWAITING_ACTIVATION
    ) {
      throw new BadRequestException({
        code: ErrorCodes.INVALID_ORDER_STATUS,
        message: 'Sengketa tahap hanya dapat dibuka untuk tahap yang sedang berjalan.',
      });
    }
    const existingDispute = await this.prisma.dispute.findUnique({ where: { orderId: order.id } });
    if (existingDispute) {
      throw new ConflictException({
        code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
        message: 'Order ini sudah memiliki sengketa aktif.',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const serial = await this.txSerial.getNextForPrefix('dispute_serial');
      const disputeId = generateDisputeId(serial);
      const isBuyer = userId === order.buyerId;
      const now = new Date();
      await tx.dispute.create({
        data: {
          disputeId,
          orderId: order.id,
          // GAP-C (G190): sengketa dibatasi ke satu tahap; tahap lain tidak terpengaruh.
          milestoneId,
          initiatorUserId: userId,
          initiatedBy: isBuyer ? DisputeInitiator.BUYER : DisputeInitiator.SELLER,
          buyerClaim: isBuyer ? reason.slice(0, 2000) : undefined,
          sellerClaim: !isBuyer ? reason.slice(0, 2000) : undefined,
          buyerClaimedAt: isBuyer ? now : undefined,
          sellerClaimedAt: !isBuyer ? now : undefined,
          status: DisputeStatus.OPEN,
          slaHours: DISPUTE_SLA_HOURS,
          slaDeadlineAt: new Date(now.getTime() + DISPUTE_SLA_HOURS * 60 * 60 * 1000),
        },
      });
      await tx.orderMilestone.update({
        where: { id: milestoneId },
        data: { status: MilestoneStatus.DISPUTED },
      });
      await this.recordEvent(tx, milestoneId, this.roleOf(order, userId), MilestoneEventType.DISPUTE_OPENED, userId, {
        reason: reason.slice(0, 500),
        disputeId,
      } as Prisma.InputJsonValue);
    });
    return { id: milestoneId, status: MilestoneStatus.DISPUTED };
  }

  /**
   * Batalkan sisa tahap (G189/G194): dana tahap yang sudah RELEASED tidak
   * disentuh; escrowHeld tahap non-released dikembalikan ke buyer sebagai
   * ORDER_REFUND parsial (ledger idempoten via metadata).
   */
  async cancelRemaining(orderId: string, userId: string) {
    const order = await this.assertParty(orderId, userId);
    const role = this.roleOf(order, userId);
    if (role !== MilestoneActorType.BUYER && role !== MilestoneActorType.SELLER) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Hanya pihak order yang dapat membatalkan.' });
    }
    // SEC-102: refund sisa tahap juga di-guard status order — tidak boleh
    // mengembalikan escrowHeld saat order DISPUTED (adjudikasi yang berhak).
    this.assertOrderAllowsMilestoneAction(order);

    // M5 (mode tanpa-wallet): refund parsial DANA per tahap (buyerAmount yang
    // masih ditahan escrow-nya), tanpa sentuh wallet.
    if (this.isNoWalletMode()) {
      return this.cancelRemainingNoWallet(order, orderId, userId, role);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const remaining = await tx.orderMilestone.findMany({
        where: {
          orderId,
          status: { in: [MilestoneStatus.DRAFT, MilestoneStatus.AWAITING_ACTIVATION, MilestoneStatus.SUBMITTED, MilestoneStatus.REVISION_REQUESTED] },
        },
        orderBy: { seq: 'asc' },
      });
      if (remaining.length === 0) {
        return { cancelled: 0, refundedAmount: 0n };
      }

      const buyerWallet = await tx.wallet.findFirst({ where: { userId: order.buyerId } });
      if (!buyerWallet) {
        throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: 'Wallet buyer tidak ditemukan.' });
      }

      let refunded = 0n;
      for (const m of remaining) {
        const meta = { milestoneId: m.id, orderDbId: order.id, orderPublicId: order.orderId, kind: 'CANCEL_REMAINING_REFUND' } as Prisma.InputJsonValue;
        // Idempotensi refund per tahap.
        const prior = await tx.walletTransaction.findFirst({
          where: { type: WalletTransactionType.ORDER_REFUND, metadata: { path: ['milestoneId'], equals: m.id } },
          select: { id: true },
        });
        if (!prior && m.escrowHeld > 0n) {
          const before = buyerWallet.escrowBalance;
          const upd = await tx.wallet.updateMany({
            where: { id: buyerWallet.id, version: buyerWallet.version },
            data: {
              escrowBalance: { decrement: m.escrowHeld },
              availableBalance: { increment: m.escrowHeld },
              version: { increment: 1 },
            },
          });
          if (upd.count === 0) {
            throw new ConflictException({
              code: ErrorCodes.OPTIMISTIC_LOCK_CONFLICT,
              message: 'Concurrent wallet update saat refund tahap.',
            });
          }
          buyerWallet.escrowBalance -= m.escrowHeld;
          buyerWallet.availableBalance += m.escrowHeld;
          buyerWallet.version += 1;
          const refundTxId = generateWalletTxId(await this.txSerial.getNext());
          await tx.walletTransaction.create({
            data: {
              txId: refundTxId,
              walletId: buyerWallet.id,
              type: WalletTransactionType.ORDER_REFUND,
              status: WalletTransactionStatus.SUCCESS,
              amount: m.escrowHeld,
              balanceBefore: before,
              balanceAfter: buyerWallet.escrowBalance,
              orderId: order.id,
              metadata: meta,
              description: `Refund escrow untuk tahap ${m.seq} yang dibatalkan (order ${order.orderId})`,
            },
          });
          refunded += m.escrowHeld;
        }
        await tx.orderMilestone.updateMany({
          where: { id: m.id, status: m.status },
          data: { status: MilestoneStatus.CANCELLED, escrowHeld: 0n },
        });
        await this.recordEvent(tx, m.id, role, MilestoneEventType.CANCELLED, userId, {
          refunded: m.escrowHeld.toString(),
        } as Prisma.InputJsonValue);
      }
      // Finalisasi order bila semua tahap sudah terminal (tanpa release legacy).
      await this.maybeFinalizeMilestoneOrder(tx, order.id);
      return { cancelled: remaining.length, refundedAmount: refunded };
    });

    await this.notifyUser(
      role === MilestoneActorType.BUYER ? order.sellerId : order.buyerId,
      NotificationType.MILESTONE_CANCELLED,
      'Sisa Tahap Dibatalkan',
      `${result.cancelled} tahap tersisa order "${order.title}" dibatalkan. Dana escrow tahap tersebut dikembalikan ke pembeli.`,
      orderId,
    );
    return { orderId: order.orderId, cancelled: result.cancelled, refundedIdr: Number(result.refundedAmount) / 100 };
  }

  /**
   * M5 (mode tanpa-wallet): batalkan sisa tahap dengan refund parsial DANA
   * per tahap ke metode bayar asal (buyerAmount/escrowHeld tahap yang masih
   * ditahan). Tahap yang sudah RELEASED tidak disentuh.
   *
   * Urutan money-first (fail-closed, self-healing):
   * - Refund DANA parsial per tahap DULU (idempoten via kunci stabil
   *   `MILESTONE_CANCEL:<milestoneId>`; refundAmount melempar bila gagal).
   * - Baru tandai CANCELLED di dalam tx. Crash di antara keduanya → retry
   *   menemukan attempt yang sudah ada (tidak refund ganda) lalu menandai
   *   CANCELLED.
   * - Tanpa payment DANA SUCCESS untuk order → tolak (fail-closed), jangan
   *   tandai CANCELLED.
   */
  private async cancelRemainingNoWallet(
    order: { id: string; orderId: string; buyerId: string; sellerId: string },
    orderId: string,
    userId: string,
    role: MilestoneActorType,
  ) {
    if (!this.danaRefund) {
      throw new ServiceUnavailableException({
        code: 'NO_WALLET_PROVIDER_UNAVAILABLE',
        message: 'Layanan refund DANA tidak tersedia — pembatalan tahap ditahan (fail-closed).',
      });
    }
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        orderId,
        purpose: PaymentPurpose.ORDER_ESCROW,
        provider: PaymentProvider.DANA,
        status: PaymentStatus.SUCCESS,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!payment) {
      throw new ServiceUnavailableException({
        code: 'MILESTONE_CANCEL_NO_DANA_PAYMENT',
        message: 'Payment DANA order tidak ditemukan — pembatalan tahap ditahan agar dana tidak nyangkut.',
      });
    }

    const OPEN: MilestoneStatus[] = [
      MilestoneStatus.DRAFT,
      MilestoneStatus.AWAITING_ACTIVATION,
      MilestoneStatus.SUBMITTED,
      MilestoneStatus.REVISION_REQUESTED,
    ];
    const remaining = await this.prisma.orderMilestone.findMany({
      where: { orderId, status: { in: OPEN } },
      orderBy: { seq: 'asc' },
    });
    if (remaining.length === 0) {
      return { orderId: order.orderId, cancelled: 0, refundedIdr: 0 };
    }

    // Money-first: refund parsial per tahap (idempoten). Tahap DRAFT murni
    // (escrowHeld=0) tidak butuh refund.
    for (const m of remaining) {
      if (m.escrowHeld <= 0n) continue;
      const outcome = await this.danaRefund.refundAmount({
        paymentDbId: payment.id,
        amountSen: m.escrowHeld,
        reason: `Refund tahap ${m.seq} yang dibatalkan (order ${order.orderId})`,
        idempotencyKey: this.milestoneCancelRefundKey(m.id),
      });
      if (!outcome.refunded) {
        throw new ServiceUnavailableException({
          code: 'MILESTONE_CANCEL_REFUND_FAILED',
          message: `Refund DANA tahap ${m.seq} gagal (${outcome.reason}) — pembatalan dibatalkan (fail-closed).`,
        });
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let refunded = 0n;
      for (const m of remaining) {
        await tx.orderMilestone.updateMany({
          where: { id: m.id, status: { in: OPEN } },
          data: { status: MilestoneStatus.CANCELLED, escrowHeld: 0n },
        });
        if (m.escrowHeld > 0n) refunded += m.escrowHeld;
        await this.recordEvent(tx, m.id, role, MilestoneEventType.CANCELLED, userId, {
          refunded: m.escrowHeld.toString(),
          noWallet: true,
          danaRefundKey: this.milestoneCancelRefundKey(m.id),
        } as Prisma.InputJsonValue);
      }
      // Finalisasi order bila semua tahap sudah terminal (tanpa release legacy).
      await this.maybeFinalizeMilestoneOrder(tx, order.id);
      return { cancelled: remaining.length, refundedAmount: refunded };
    });

    await this.notifyUser(
      role === MilestoneActorType.BUYER ? order.sellerId : order.buyerId,
      NotificationType.MILESTONE_CANCELLED,
      'Sisa Tahap Dibatalkan',
      `${result.cancelled} tahap tersisa order "${order.orderId}" dibatalkan. Dana tahap tersebut dikembalikan ke metode pembayaran asal.`,
      orderId,
    );
    return { orderId: order.orderId, cancelled: result.cancelled, refundedIdr: Number(result.refundedAmount) / 100 };
  }

  /**
   * M5: dipakai adminCancelOrder (no-wallet) untuk order bertahap — refund
   * parsial DANA per tahap yang belum cair, TANPA menyentuh wallet.
   *
   * Mengembalikan `{ routed: true }` bila order punya milestone (caller TIDAK
   * boleh lanjut ke refundOrderEscrow penuh — tahap yang sudah RELEASED
   * dananya sudah di tangan seller; refund penuh akan over-refund).
   * `{ routed: false }` bila bukan order milestone / bukan mode no-wallet.
   */
  async adminCancelMilestonesNoWallet(orderDbId: string, adminId: string, _reason: string) {
    if (!this.isNoWalletMode()) return { routed: false as const };
    const order = await this.prisma.order.findUnique({
      where: { id: orderDbId },
      select: { id: true, orderId: true, buyerId: true, sellerId: true },
    });
    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order tidak ditemukan.' });
    }
    const milestoneCount = await this.prisma.orderMilestone.count({ where: { orderId: orderDbId } });
    if (milestoneCount === 0) return { routed: false as const };
    const res = await this.cancelRemainingNoWallet(order, orderDbId, adminId, MilestoneActorType.ADMIN);
    return { routed: true as const, ...res };
  }

  // ------------------------------------------------------ reconcile (G199)

  /**
   * Rekonsiliasi invariant dana satu order (dipakai admin + health check).
   * Invariant: sum(amount)=orderValue; sum(buyerAmount)=buyerPayAmount;
   * sum(sellerAmount)=sellerReceiveAmount; sum(feeAmount)=feeAmount;
   * sum(escrowHeld)+sum(released buyerAmount)=buyerPayAmount (utk order aktif).
   */
  async reconcileOrder(orderId: string) {
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { milestones: true },
    });
    if (order.milestones.length === 0) {
      return { orderId: order.orderId, hasMilestones: false, ok: true, checks: [] as string[] };
    }
    const sum = (f: (m: (typeof order.milestones)[number]) => bigint) =>
      order.milestones.reduce((a, m) => a + f(m), 0n);
    const releasedBuyer = sum((m) => (m.status === MilestoneStatus.RELEASED ? m.buyerAmount : 0n));
    // expected/actual ditampilkan dalam IDR (kontrak admin), perbandingan
    // tetap dalam sen agar eksak.
    const idr = (v: bigint) => toIdr(v).toString();
    const checks: { name: string; ok: boolean; expected: string; actual: string }[] = [
      { name: 'sum(amount)=orderValue', ok: sum((m) => m.amount) === order.orderValue, expected: idr(order.orderValue), actual: idr(sum((m) => m.amount)) },
      { name: 'sum(buyerAmount)=buyerPayAmount', ok: sum((m) => m.buyerAmount) === order.buyerPayAmount, expected: idr(order.buyerPayAmount), actual: idr(sum((m) => m.buyerAmount)) },
      { name: 'sum(sellerAmount)=sellerReceiveAmount', ok: sum((m) => m.sellerAmount) === order.sellerReceiveAmount, expected: idr(order.sellerReceiveAmount), actual: idr(sum((m) => m.sellerAmount)) },
      { name: 'sum(feeAmount)=feeAmount', ok: sum((m) => m.feeAmount) === order.feeAmount, expected: idr(order.feeAmount), actual: idr(sum((m) => m.feeAmount)) },
      {
        name: 'escrowHeld+released=buyerPayAmount',
        ok: sum((m) => m.escrowHeld) + releasedBuyer === order.buyerPayAmount,
        expected: idr(order.buyerPayAmount),
        actual: idr(sum((m) => m.escrowHeld) + releasedBuyer),
      },
    ];
    const ok = checks.every((c) => c.ok);
    if (!ok) {
      this.logger.error(`Milestone invariant violation for order ${order.orderId}: ${JSON.stringify(checks.filter((c) => !c.ok))}`);
    }
    return { orderId: order.orderId, hasMilestones: true, ok, checks };
  }
}
