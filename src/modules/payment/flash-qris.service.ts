import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError } from 'axios';

/**
 * Flash Mobile (MNC Group) — QRIS payment gateway.
 *
 * Menggantikan Midtrans untuk pembayaran QRIS (keputusan produk 2026-09-26).
 * Docs: https://api-doc.flashmobile.id/
 *
 * Alur:
 * 1. POST /priv/v1/pg/token {client_key, server_key} → JWT (cache ~7 hari)
 * 2. POST /payment/api/v1/qris/payment → qr_string (ditampilkan sebagai QR)
 * 3. Webhook POST ke FLASH_CALLBACK_URL saat status berubah
 * 4. GET /payment/api/v1/qris/payment-status/{transactionId} (polling/rekonsiliasi)
 *
 * Catatan: dokumentasi Flash TIDAK menjelaskan mekanisme verifikasi signature
 * webhook — keaslian callback hanya bisa dipastikan via pencocokan
 * transaction_id/external_id + verifikasi status via API (langkah 4).
 */
export interface FlashQrisCreateParams {
  externalId: string;
  amountIdr: number;
  description?: string;
  sessionTimeMinutes?: number;
  fullname?: string;
  email?: string;
  phoneNumber?: string;
}

export interface FlashQrisPayment {
  transactionId: string;
  externalId: string;
  amountIdr: number;
  qrString: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  expiredAt: Date;
}

export type FlashQrisStatus = 'PENDING' | 'SUCCESS' | 'FAILED' | 'UNKNOWN';

/**
 * Detail pembayaran dari API Flash — dipakai untuk verifikasi amount
 * (WF-007). `amountIdr` null bila field amount tidak ada / tidak bisa
 * diparse dari respons Flash (shape tak terdokumentasi penuh).
 */
export interface FlashQrisPaymentDetail {
  status: FlashQrisStatus;
  amountIdr: number | null;
  transactionId: string;
}

@Injectable()
export class FlashQrisService {
  private readonly logger = new Logger(FlashQrisService.name);
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('flash.baseUrl') ?? '';
  }

  private get enabled(): boolean {
    return Boolean(this.config.get<string>('flash.clientKey') && this.config.get<string>('flash.serverKey'));
  }

  private assertEnabled(): void {
    if (!this.enabled) {
      throw new ServiceUnavailableException({
        code: 'FLASH_NOT_CONFIGURED',
        message: 'Pembayaran QRIS belum dikonfigurasi. Hubungi admin.',
      });
    }
  }

  /**
   * Token JWT OAuth2 — di-cache di memori (klaim docs: valid ~7 hari;
   * refresh 1 jam sebelum kedaluwarsa untuk aman).
   */
  async getToken(): Promise<string> {
    this.assertEnabled();
    if (this.cachedToken && Date.now() < this.tokenExpiresAt) {
      return this.cachedToken;
    }
    try {
      const res = await axios.post(
        `${this.baseUrl}/priv/v1/pg/token`,
        {
          client_key: this.config.get<string>('flash.clientKey'),
          server_key: this.config.get<string>('flash.serverKey'),
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 },
      );
      const token = res.data?.data?.token as string | undefined;
      if (!token) {
        throw new Error('Token tidak ada di respons Flash');
      }
      this.cachedToken = token;
      // Klaim docs 7 hari; refresh setelah 6 hari untuk margin aman.
      this.tokenExpiresAt = Date.now() + 6 * 24 * 3_600_000;
      return token;
    } catch (err) {
      this.logger.error('Gagal mendapatkan token Flash', err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException({
        code: 'FLASH_TOKEN_FAILED',
        message: 'Gagal terhubung ke layanan pembayaran QRIS.',
      });
    }
  }

  /**
   * Buat pembayaran QRIS dinamis. Mengembalikan qr_string untuk dirender
   * menjadi QR code di aplikasi.
   */
  async createQrisPayment(params: FlashQrisCreateParams): Promise<FlashQrisPayment> {
    this.assertEnabled();
    const token = await this.getToken();
    const sessionTime = params.sessionTimeMinutes
      ?? this.config.get<number>('flash.qrisExpiryMinutes')
      ?? 30;

    try {
      const res = await axios.post(
        `${this.baseUrl}/payment/api/v1/qris/payment`,
        {
          terminal_id: params.externalId.slice(0, 16),
          external_id: params.externalId.slice(0, 16),
          amount: Math.round(params.amountIdr),
          description: params.description ?? '',
          session_time: Math.max(1, sessionTime),
          fullname: params.fullname ?? '',
          email: params.email ?? '',
          phone_number: params.phoneNumber ?? '',
        },
        {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          timeout: 20_000,
        },
      );
      const data = res.data?.data ?? {};
      const qrString = data.qr_string as string | undefined;
      const transactionId = data.transaction_id as string | undefined;
      if (!qrString || !transactionId) {
        throw new Error('qr_string/transaction_id tidak ada di respons Flash');
      }
      return {
        transactionId,
        externalId: params.externalId,
        amountIdr: Math.round(params.amountIdr),
        qrString,
        status: this.mapStatus(data.status),
        expiredAt: new Date(Date.now() + sessionTime * 60_000),
      };
    } catch (err) {
      this.logger.error('Gagal membuat pembayaran QRIS Flash', err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException({
        code: 'FLASH_QRIS_CREATE_FAILED',
        message: 'Gagal membuat kode QRIS. Coba lagi.',
      });
    }
  }

  /**
   * Cek status pembayaran — dipakai untuk polling frontend & rekonsiliasi.
   */
  async getPaymentStatus(transactionId: string): Promise<FlashQrisStatus> {
    const detail = await this.getPaymentDetail(transactionId);
    return detail.status;
  }

  /**
   * Ambil status + nominal terbayar dari API Flash.
   *
   * WF-007: nominal dipakai untuk verifikasi amount sebelum aktivasi
   * subscription (fail-closed bila mismatch). Parsing defensif: field
   * amount di respons Flash tidak terdokumentasi penuh, sehingga ketidakhadiran
   * field menghasilkan `amountIdr: null` (bukan error) — pemanggil yang
   * memutuskan kebijakan fail-open/fail-closed.
   */
  async getPaymentDetail(transactionId: string): Promise<FlashQrisPaymentDetail> {
    this.assertEnabled();
    const token = await this.getToken();
    try {
      const res = await axios.get(
        `${this.baseUrl}/payment/api/v1/qris/payment-status/${encodeURIComponent(transactionId)}`,
        {
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          timeout: 15_000,
        },
      );
      const data = res.data?.data ?? {};
      return {
        status: this.mapStatus(data?.status),
        amountIdr: this.parseAmountIdr(data?.amount ?? data?.gross_amount ?? data?.paid_amount),
        transactionId,
      };
    } catch (err) {
      if (err instanceof AxiosError && err.response?.status === 404) {
        return { status: 'UNKNOWN', amountIdr: null, transactionId };
      }
      this.logger.warn(`Gagal cek status QRIS Flash ${transactionId}: ${err instanceof Error ? err.message : String(err)}`);
      return { status: 'UNKNOWN', amountIdr: null, transactionId };
    }
  }

  /** Parse nominal IDR dari berbagai kemungkinan shape respons Flash. */
  private parseAmountIdr(raw: unknown): number | null {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.round(raw);
    if (typeof raw === 'string') {
      const cleaned = raw.replace(/[^0-9.]/g, '');
      if (!cleaned) return null;
      const n = Number(cleaned);
      if (Number.isFinite(n) && n >= 0) return Math.round(n);
    }
    return null;
  }

  private mapStatus(raw: unknown): 'PENDING' | 'SUCCESS' | 'FAILED' {
    if (raw === 'SUCCESS') return 'SUCCESS';
    if (raw === 'FAILED') return 'FAILED';
    return 'PENDING';
  }
}
