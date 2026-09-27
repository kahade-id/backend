import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateReceiptTokenDto, ReceiptKind } from './dto/create-receipt-token.dto';

/**
 * Data struk yang dikembalikan ke publik — SENGAJA tanpa PII.
 * Hanya: jenis, status, nominal, tanggal. Tidak ada nama/phone/email.
 */
export interface ReceiptPayload {
  valid: true;
  kind: ReceiptKind;
  /** Status CURRENT dari record asli di database (bukan dari token). */
  status: string;
  /** Nominal dalam sen (IDR x 100), string agar presisi BigInt aman. */
  amount: string;
  currency: 'IDR';
  /** ISO-8601 timestamp kejadian. */
  occurredAt: string;
}

export type VerifyResult = ReceiptPayload | { valid: false };

interface ResolvedRecord {
  status: string;
  amount: string;
  occurredAt: string;
}

const CLOCK_SKEW_SECONDS = 300;

const KIND_LABELS: Record<ReceiptKind, string> = {
  [ReceiptKind.WALLET_TX]: 'Transaksi Wallet',
  [ReceiptKind.TRANSFER]: 'Transfer Saldo',
  [ReceiptKind.ORDER_PAYMENT]: 'Pembayaran Order (Escrow)',
  [ReceiptKind.TOPUP]: 'Top-up Saldo',
  [ReceiptKind.WITHDRAWAL]: 'Penarikan Dana',
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Menunggu',
  SUCCESS: 'Berhasil',
  FAILED: 'Gagal',
  CANCELLED: 'Dibatalkan',
  REVERSED: 'Dibalikkan',
  EXPIRED: 'Kedaluwarsa',
  REFUNDED: 'Dana Dikembalikan',
  WAITING_CONFIRMATION: 'Menunggu Konfirmasi',
  WAITING_PAYMENT: 'Menunggu Pembayaran',
  PROCESSING: 'Diproses',
  IN_DELIVERY: 'Dalam Pengiriman',
  COMPLETED: 'Selesai',
  DISPUTED: 'Disengketakan',
  PENDING_OTP: 'Menunggu OTP',
  PENDING_PROCESS: 'Menunggu Diproses',
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRupiah(sen: string): string {
  try {
    const rupiah = BigInt(sen) / 100n;
    return 'Rp ' + rupiah.toLocaleString('id-ID');
  } catch {
    return 'Rp -';
  }
}

function formatTanggalWib(iso: string): string {
  try {
    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'Asia/Jakarta',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private getSecret(): string {
    const secret = this.config.get<string>('receipt.hmacSecret') ?? '';
    if (!secret) {
      // Fail-closed: jangan pernah menandatangani/memverifikasi tanpa secret.
      throw new InternalServerErrorException('Receipt signing is not configured');
    }
    return secret;
  }

  private getTtlSeconds(): number {
    return this.config.get<number>('receipt.ttlSeconds') ?? 2 * 365 * 24 * 3600;
  }

  // ------------------------------------------------------------------
  // Penerbitan token (AUTHENTICATED)
  // ------------------------------------------------------------------

  async createToken(
    userId: string,
    dto: CreateReceiptTokenDto,
  ): Promise<{ token: string; verifyUrl: string }> {
    // Ownership check fail-closed: record bukan milik user → 404.
    await this.resolveOwned(dto.kind, dto.referenceId, userId);

    const token = this.signToken(dto.kind, dto.referenceId);
    const baseUrl = this.config.get<string>('receipt.publicBaseUrl') ?? 'https://api.kahade.id';
    return { token, verifyUrl: `${baseUrl}/v1/receipts/verify/${token}` };
  }

  // ------------------------------------------------------------------
  // Verifikasi token (PUBLIC)
  // ------------------------------------------------------------------

  async verifyToken(token: string): Promise<VerifyResult> {
    const parsed = this.parseAndVerifySignature(token);
    if (!parsed) return { valid: false };

    const record = await this.resolvePublic(parsed.kind, parsed.referenceId);
    if (!record) return { valid: false };

    return {
      valid: true,
      kind: parsed.kind,
      status: record.status,
      amount: record.amount,
      currency: 'IDR',
      occurredAt: record.occurredAt,
    };
  }

  // ------------------------------------------------------------------
  // Penandatanganan stateless: base64url(JSON).base64url(HMAC-SHA256)
  // ------------------------------------------------------------------

  private signToken(kind: ReceiptKind, referenceId: string): string {
    const iat = Math.floor(Date.now() / 1000);
    const payloadB64 = Buffer.from(
      JSON.stringify({ k: kind, r: referenceId, iat }),
      'utf8',
    ).toString('base64url');
    const sigB64 = createHmac('sha256', this.getSecret()).update(payloadB64).digest('base64url');
    return `${payloadB64}.${sigB64}`;
  }

  private parseAndVerifySignature(
    token: string,
  ): { kind: ReceiptKind; referenceId: string } | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;
    if (!/^[A-Za-z0-9_-]+$/.test(payloadB64) || !/^[A-Za-z0-9_-]+$/.test(sigB64)) return null;

    const expected = createHmac('sha256', this.getSecret()).update(payloadB64).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(sigB64, 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) return null;

    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
    const { k, r, iat } = data as { k?: unknown; r?: unknown; iat?: unknown };
    if (typeof k !== 'string' || typeof r !== 'string' || !Number.isInteger(iat)) return null;
    if (!(Object.values(ReceiptKind) as string[]).includes(k)) return null;

    // Kadaluarsa: iat tidak boleh lebih tua dari TTL, dan tidak boleh di masa depan
    // (toleransi clock skew kecil).
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = iat as number;
    if (issuedAt > now + CLOCK_SKEW_SECONDS) return null;
    if (now - issuedAt > this.getTtlSeconds()) return null;

    return { kind: k as ReceiptKind, referenceId: r };
  }

  // ------------------------------------------------------------------
  // Resolver per kind → tabel Prisma (additive-only, tanpa ubah schema)
  // ------------------------------------------------------------------

  private refFilter(referenceId: string, idField: 'txId' | 'orderId' | 'id') {
    return idField === 'id'
      ? { id: referenceId }
      : { OR: [{ [idField]: referenceId }, { id: referenceId }] };
  }

  private async resolveWalletTx(
    referenceId: string,
    userId: string | null,
    types?: Array<'TRANSFER_SENT' | 'TRANSFER_RECEIVED' | 'WITHDRAW'>,
  ): Promise<ResolvedRecord | null> {
    const tx = await this.prisma.walletTransaction.findFirst({
      where: {
        AND: [
          this.refFilter(referenceId, 'txId'),
          ...(types ? [{ type: { in: types } }] : []),
          ...(userId ? [{ wallet: { userId } }] : []),
        ],
      },
      select: {
        type: true,
        status: true,
        withdrawStatus: true,
        amount: true,
        completedAt: true,
        createdAt: true,
      },
    });
    if (!tx) return null;
    const status =
      tx.type === 'WITHDRAW' && tx.withdrawStatus ? tx.withdrawStatus : tx.status;
    return {
      status,
      amount: tx.amount.toString(),
      occurredAt: (tx.completedAt ?? tx.createdAt).toISOString(),
    };
  }

  private async resolveOrder(
    referenceId: string,
    userId: string | null,
  ): Promise<ResolvedRecord | null> {
    const order = await this.prisma.order.findFirst({
      where: {
        AND: [
          this.refFilter(referenceId, 'orderId'),
          ...(userId ? [{ OR: [{ buyerId: userId }, { sellerId: userId }] }] : []),
        ],
      },
      select: {
        status: true,
        buyerPayAmount: true,
        paidAt: true,
        createdAt: true,
      },
    });
    if (!order) return null;
    return {
      status: order.status,
      amount: order.buyerPayAmount.toString(),
      occurredAt: (order.paidAt ?? order.createdAt).toISOString(),
    };
  }

  private async resolveTopup(
    referenceId: string,
    userId: string | null,
  ): Promise<ResolvedRecord | null> {
    const payment = await this.prisma.paymentTransaction.findFirst({
      where: {
        AND: [
          { OR: [{ id: referenceId }, { midtransOrderId: referenceId }] },
          { purpose: 'TOPUP' },
          ...(userId ? [{ userId }] : []),
        ],
      },
      select: {
        status: true,
        amount: true,
        paidAt: true,
        createdAt: true,
      },
    });
    if (!payment) return null;
    return {
      status: payment.status,
      amount: payment.amount.toString(),
      occurredAt: (payment.paidAt ?? payment.createdAt).toISOString(),
    };
  }

  private async resolveOwned(
    kind: ReceiptKind,
    referenceId: string,
    userId: string,
  ): Promise<ResolvedRecord> {
    const record = await this.resolveRecord(kind, referenceId, userId);
    if (!record) {
      // Fail-closed: record tidak ada ATAU bukan milik user → 404 generik
      // (tidak membocorkan keberadaan record milik orang lain).
      throw new NotFoundException('Receipt reference not found');
    }
    return record;
  }

  private async resolvePublic(
    kind: ReceiptKind,
    referenceId: string,
  ): Promise<ResolvedRecord | null> {
    return this.resolveRecord(kind, referenceId, null);
  }

  private async resolveRecord(
    kind: ReceiptKind,
    referenceId: string,
    userId: string | null,
  ): Promise<ResolvedRecord | null> {
    switch (kind) {
      case ReceiptKind.WALLET_TX:
        return this.resolveWalletTx(referenceId, userId);
      case ReceiptKind.TRANSFER:
        return this.resolveWalletTx(referenceId, userId, ['TRANSFER_SENT', 'TRANSFER_RECEIVED']);
      case ReceiptKind.ORDER_PAYMENT:
        return this.resolveOrder(referenceId, userId);
      case ReceiptKind.TOPUP:
        return this.resolveTopup(referenceId, userId);
      case ReceiptKind.WITHDRAWAL:
        return this.resolveWalletTx(referenceId, userId, ['WITHDRAW']);
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------
  // Render HTML minimal (content negotiation text/html)
  // ------------------------------------------------------------------

  renderReceiptHtml(result: VerifyResult): string {
    if (!result.valid) {
      return this.htmlShell(
        'Struk Tidak Ditemukan',
        `<div class="card invalid">
          <div class="mark">✕</div>
          <h1>Struk tidak ditemukan</h1>
          <p>Tautan struk tidak valid, sudah kedaluwarsa, atau record sumbernya sudah tidak tersedia.</p>
        </div>`,
      );
    }

    const kindLabel = escapeHtml(KIND_LABELS[result.kind] ?? result.kind);
    const statusLabel = escapeHtml(STATUS_LABELS[result.status] ?? result.status);
    const amount = escapeHtml(formatRupiah(result.amount));
    const tanggal = escapeHtml(formatTanggalWib(result.occurredAt));

    return this.htmlShell(
      'Struk Valid — Kahade',
      `<div class="card">
        <div class="mark ok">✓</div>
        <h1>Struk valid</h1>
        <p class="sub">Struk ini terverifikasi dan datanya diambil langsung dari sistem Kahade.</p>
        <dl>
          <div><dt>Jenis transaksi</dt><dd>${kindLabel}</dd></div>
          <div><dt>Status</dt><dd><span class="badge">${statusLabel}</span></dd></div>
          <div><dt>Nominal</dt><dd class="amount">${amount}</dd></div>
          <div><dt>Tanggal</dt><dd>${tanggal}</dd></div>
        </dl>
      </div>`,
    );
  }

  private htmlShell(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f6f8; margin: 0; padding: 32px 16px; color: #1a1a1a; }
  .card { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 32px 28px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; }
  .card.invalid { border-top: 6px solid #d32f2f; }
  .card:not(.invalid) { border-top: 6px solid #2e7d32; }
  .mark { width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 16px; font-size: 32px; line-height: 64px; color: #fff; }
  .mark.ok { background: #2e7d32; }
  .invalid .mark { background: #d32f2f; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .sub { color: #666; font-size: 14px; margin: 0 0 20px; }
  dl { text-align: left; margin: 0; }
  dl > div { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; border-top: 1px solid #eee; }
  dt { color: #666; font-size: 14px; }
  dd { margin: 0; font-weight: 600; font-size: 14px; text-align: right; }
  dd.amount { font-size: 18px; color: #1a1a1a; }
  .badge { background: #e8f5e9; color: #2e7d32; padding: 4px 12px; border-radius: 999px; font-size: 13px; }
  .foot { max-width: 480px; margin: 16px auto 0; text-align: center; color: #999; font-size: 12px; }
</style>
</head>
<body>
${body}
<p class="foot">Kahade — Rekber Digital Indonesia</p>
</body>
</html>`;
  }
}
