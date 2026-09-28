import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { OtpService } from './otp.service';
import { OtpGatewayService } from './otp-gateway.service';
import { OpsSettingsService } from '../ops-settings/ops-settings.service';
import { TokenService } from './token.service';
import { AuthLocationService } from './auth-location.service';
import { hashPhoneNumber } from '../../common/utils/pii.util';
import {
  normalizeIndonesianPhone,
  normalizeSenderPhoneLoose,
  samePhoneNumber,
} from '../../common/utils/phone.util';
import {
  OTP_TRIGGER,
  OTP_TRIGGER_COOLDOWN,
  OTP_TRIGGER_INBOX,
  OTP_TRIGGER_IP_RATE,
  OTP_TRIGGER_PHONE_RATE,
} from '../../common/constants/redis-keys';
import * as ErrorCodes from '../../common/constants/error-codes';
import { OtpType } from '@prisma/client';
import { OtpTriggerPurpose, RequestOtpTriggerDto } from './dto/otp-trigger.dto';
import type { LocationDto } from './dto/location.dto';

export type OtpTriggerStatus = 'WAITING' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

/** Nomor WhatsApp resmi Kahade — satu-satunya nomor pengirim trigger. */
export const KAHADE_WA_NUMBER = '6285786035715';
export const TRIGGER_TTL_SECONDS = 600;
const TRIGGER_COOLDOWN_SECONDS = 60;
const TRIGGER_PHONE_RATE_LIMIT = 10;
const TRIGGER_IP_RATE_LIMIT = 20;
const TRIGGER_RATE_WINDOW_SECONDS = 3600;
const REFCODE_BYTES = 6; // 12 hex chars — jauh lebih kuat dari 4 hex

interface TriggerRecord {
  phoneNumber: string; // +62...
  deviceId?: string;
  purpose: OtpTriggerPurpose;
  userId?: string; // terikat untuk forgot_password & migrate_phone
  status: OtpTriggerStatus;
  createdAt: string;
  expiresAt: string;
  otpSentAt?: string;
  /** 03-#3: true untuk record decoy anti-enumerasi — webhook tidak boleh
   * menyelesaikan/mengirim OTP untuknya, tetapi siklus status polling
   * harus identik dengan trigger asli. */
  decoy?: boolean;
}

export interface TriggerPayload {
  refCode: string;
  triggerText: string;
  whatsappUrl: string;
  expiresInSeconds: number;
  expiresAt: string;
}

/**
 * Alur OTP satu-satunya: user-initiated via WhatsApp.
 *
 * 1. Client: POST /v1/auth/otp-trigger → terima refCode + wa.me link.
 * 2. User: buka WhatsApp, kirim "KAHADE <refCode>" ke +6285786035715.
 * 3. Fonnte: webhook pesan masuk → handleFonnteWebhook().
 * 4. Backend: cocokkan refCode + nomor pengirim → generate OTP →
 *    balas via Fonnte → tandai COMPLETED.
 * 5. Client: polling GET .../status/:refCode → COMPLETED → layar input OTP.
 * 6. Client: POST /v1/auth/verify-otp → sesi / tempToken sesuai purpose.
 *
 * Tidak ada jalur kirim-langsung (direct send): bot tidak pernah mem-push
 * OTP duluan — pola itu rawan dilaporkan sebagai spam dan membekukan
 * akun bot WhatsApp.
 */
@Injectable()
export class OtpTriggerService {
  private readonly logger = new Logger(OtpTriggerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly otpService: OtpService,
    private readonly otpGateway: OtpGatewayService,
    private readonly tokenService: TokenService,
    private readonly locationService: AuthLocationService,
    private readonly config: ConfigService,
    private readonly opsSettings: OpsSettingsService,
  ) {}

  // ── Pembuatan trigger ────────────────────────────────────────────

  async createTrigger(
    dto: RequestOtpTriggerDto,
    ipAddress: string,
  ): Promise<TriggerPayload> {
    const phoneNumber = normalizeIndonesianPhone(dto.phoneNumber);
    const phoneHash = hashPhoneNumber(phoneNumber);

    // Rate limit: cooldown per nomor+purpose, lalu rate per nomor & per IP.
    const cooldownKey = OTP_TRIGGER_COOLDOWN(phoneNumber, dto.purpose);
    const cooldownClaimed = await this.redis.setNx(cooldownKey, '1', TRIGGER_COOLDOWN_SECONDS);
    if (!cooldownClaimed) {
      throw new BadRequestException({
        code: ErrorCodes.TOO_MANY_REQUESTS,
        message: `Tunggu ${TRIGGER_COOLDOWN_SECONDS} detik sebelum meminta kode baru`,
      });
    }
    try {
      const phoneCount = await this.redis.incrWithTtl(
        OTP_TRIGGER_PHONE_RATE(phoneNumber),
        TRIGGER_RATE_WINDOW_SECONDS,
      );
      if (phoneCount > TRIGGER_PHONE_RATE_LIMIT) {
        throw new BadRequestException({
          code: ErrorCodes.TOO_MANY_REQUESTS,
          message: 'Terlalu banyak permintaan untuk nomor ini. Coba lagi nanti.',
        });
      }
      const ipCount = await this.redis.incrWithTtl(
        OTP_TRIGGER_IP_RATE(ipAddress),
        TRIGGER_RATE_WINDOW_SECONDS,
      );
      if (ipCount > TRIGGER_IP_RATE_LIMIT) {
        throw new BadRequestException({
          code: ErrorCodes.TOO_MANY_REQUESTS,
          message: 'Terlalu banyak permintaan dari jaringan ini. Coba lagi nanti.',
        });
      }

      // Prekondisi per purpose.
      // Catatan anti-enumerasi: untuk REGISTER (nomor sudah terdaftar) dan
      // FORGOT_PASSWORD (nomor tidak dikenal / akun nonaktif / terkunci),
      // kembalikan payload "decoy" yang bentuknya identik dengan sukses
      // DAN siklus status polling-nya identik (record WAITING di Redis
      // dengan flag decoy; webhook menyelesaikannya tanpa mengirim OTP —
      // lihat handleFonnteWebhook). 03-#3: sebelumnya decoy tidak disimpan
      // sehingga langsung EXPIRED — orakel enumerasi via polling.
      let boundUserId: string | undefined;
      if (dto.purpose === OtpTriggerPurpose.REGISTER) {
        const existing = await this.findUserByPhone(phoneNumber, phoneHash);
        if (existing) {
          return this.buildDecoyTriggerPayload({
            phoneNumber,
            deviceId: dto.deviceId,
            purpose: dto.purpose,
          });
        }
      } else if (dto.purpose === OtpTriggerPurpose.FORGOT_PASSWORD) {
        const user = await this.findUserByPhone(phoneNumber, phoneHash);
        if (
          !user ||
          !user.isActive ||
          user.isBanned ||
          (user.lockedUntil && user.lockedUntil > new Date())
        ) {
          return this.buildDecoyTriggerPayload({
            phoneNumber,
            deviceId: dto.deviceId,
            purpose: dto.purpose,
          });
        }
        boundUserId = user.id;
      } else if (dto.purpose === OtpTriggerPurpose.MIGRATE_PHONE) {
        if (!dto.migrationToken) {
          throw new UnauthorizedException({
            code: ErrorCodes.UNAUTHORIZED,
            message: 'Token migrasi wajib diisi',
          });
        }
        let payload;
        try {
          payload = this.tokenService.verifyTempToken(dto.migrationToken);
        } catch {
          throw new UnauthorizedException({
            code: ErrorCodes.TEMP_TOKEN_EXPIRED,
            message: 'Sesi migrasi kedaluwarsa. Silakan masuk ulang.',
          });
        }
        if (payload.scope !== 'phone_migration') {
          throw new UnauthorizedException({
            code: ErrorCodes.UNAUTHORIZED,
            message: 'Token tidak valid untuk migrasi',
          });
        }
        if (payload.deviceId && payload.deviceId !== dto.deviceId) {
          throw new UnauthorizedException({
            code: ErrorCodes.UNAUTHORIZED,
            message: 'Token migrasi tidak berlaku untuk perangkat ini',
          });
        }
        const owner = await this.findUserByPhone(phoneNumber, phoneHash);
        if (owner && owner.id !== payload.sub) {
          throw new ConflictException({
            code: ErrorCodes.VALIDATION_ERROR,
            message: 'Nomor HP sudah dipakai akun lain.',
          });
        }
        boundUserId = payload.sub;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + TRIGGER_TTL_SECONDS * 1000);
      const record: TriggerRecord = {
        phoneNumber,
        deviceId: dto.deviceId,
        purpose: dto.purpose,
        userId: boundUserId,
        status: 'WAITING',
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      };
      // Klaim atomik (SET NX): dua request konkuren tidak bisa saling
      // menimpa record trigger — pola check-then-set sebelumnya punya race.
      const refCode = await this.claimUniqueRefCode(record);

      await this.locationService.logEvent({
        userId: boundUserId ?? null,
        event: 'otp_trigger',
        location: dto.location ?? null,
        ipAddress,
        deviceId: dto.deviceId,
      });

      const triggerText = `KAHADE ${refCode}`;
      return {
        refCode,
        triggerText,
        whatsappUrl: `https://wa.me/${KAHADE_WA_NUMBER}?text=${encodeURIComponent(triggerText)}`,
        expiresInSeconds: TRIGGER_TTL_SECONDS,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (error) {
      await this.redis.del(cooldownKey).catch(() => undefined);
      throw error;
    }
  }

  async getTriggerStatus(refCode: string): Promise<{ status: OtpTriggerStatus; purpose?: OtpTriggerPurpose }> {
    const code = refCode.toUpperCase().trim();
    if (!/^[A-F0-9]{12}$/.test(code)) {
      return { status: 'EXPIRED' };
    }
    const raw = await this.redis.get(OTP_TRIGGER(code));
    if (!raw) return { status: 'EXPIRED' };
    try {
      const record = JSON.parse(raw) as TriggerRecord;
      if (record.status === 'WAITING' && new Date(record.expiresAt).getTime() <= Date.now()) {
        return { status: 'EXPIRED', purpose: record.purpose };
      }
      return { status: record.status, purpose: record.purpose };
    } catch {
      return { status: 'EXPIRED' };
    }
  }

  // ── Webhook pesan masuk Fonnte ───────────────────────────────────

  /**
   * SEC-A M1 (fail-closed): bila FONNTE_WEBHOOK_SECRET belum dikonfigurasi,
   * webhook DITOLAK. Fail-open sebelumnya memungkinkan siapa pun mengirim
   * webhook palsu ke /v1/auth/webhooks/fonnte dan memicu alur OTP.
   * Produksi WAJIB set FONNTE_WEBHOOK_SECRET via admin panel (Pengaturan
   * Operasional) atau production .env.
   */
  verifyWebhookSecret(provided?: string): boolean {
    // OPS: secret dibaca via OpsSettingsService (DB panel > .env) agar bisa
    // diset dari admin panel tanpa SSH ke server.
    const expected = this.opsSettings.getSecret('FONNTE_WEBHOOK_SECRET');
    if (!expected) {
      // Secret belum dikonfigurasi: TOLAK webhook (fail-closed). Jangan
      // pernah menerima webhook tanpa verifikasi secret.
      this.logger.error(
        '[SECURITY] FONNTE_WEBHOOK_SECRET is not set — rejecting Fonnte webhook (fail-closed). ' +
          'ACTION REQUIRED: set FONNTE_WEBHOOK_SECRET via admin panel (Pengaturan Operasional) or production .env. ' +
          'Kirim secret via header x-fonnte-secret (disarankan) atau field body webhookSecret — JANGAN via query param ?webhookSecret= ' +
          'karena URL tercatat di nginx access log (SEC-003). Webhook URL di dashboard Fonnte: https://api.kahade.id/v1/auth/webhooks/fonnte.',
      );
      return false;
    }
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Menangani webhook pesan masuk dari Fonnte.
   * Format (docs.fonnte.com): { device, sender, message, name, inboxid, ... }.
   * Selalu resolve tanpa throw — Fonnte me-retry bila respons non-2xx.
   *
   * Idempotensi dua lapis:
   * 1. inboxid (setNx) — retry/duplikat webhook untuk pesan yang sama
   *    tidak pernah memproses dua kali.
   * 2. status record — hanya WAITING/FAILED yang diproses; COMPLETED
   *    diabaikan (pesan trigger yang dikirim user berulang kali).
   */
  async handleFonnteWebhook(body: Record<string, unknown>): Promise<void> {
    try {
      const sender = typeof body.sender === 'string' ? body.sender : '';
      const message = typeof body.message === 'string' ? body.message : '';
      const inboxId =
        typeof body.inboxid === 'string' && body.inboxid.trim()
          ? body.inboxid.trim().slice(0, 128)
          : null;
      if (!sender || !message) return;

      const match = /KAHADE\s+([A-F0-9]{12})/i.exec(message);
      if (!match) return;
      const refCode = match[1].toUpperCase();

      // Lapis 1: dedup per pesan masuk.
      if (inboxId) {
        const first = await this.redis.setNx(OTP_TRIGGER_INBOX(inboxId), refCode, 86400);
        if (!first) return;
      }

      const raw = await this.redis.get(OTP_TRIGGER(refCode));
      if (!raw) return;
      const record = JSON.parse(raw) as TriggerRecord;
      if (record.status === 'COMPLETED') return;
      if (record.status !== 'WAITING' && record.status !== 'FAILED') return;
      if (new Date(record.expiresAt).getTime() <= Date.now()) {
        record.status = 'EXPIRED';
        await this.redis.set(OTP_TRIGGER(refCode), JSON.stringify(record), 300);
        return;
      }

      const senderPhone = normalizeSenderPhoneLoose(sender);
      if (!senderPhone || !samePhoneNumber(senderPhone, record.phoneNumber)) {
        this.logger.warn(
          `[OTP-TRIGGER] refCode=${refCode} sender mismatch (sender=${sender.slice(0, 6)}...)`,
        );
        return;
      }

      // 03-#3: record decoy anti-enumerasi — selesaikan TANPA mengirim OTP.
      // Siklus status polling (WAITING → COMPLETED) tetap identik dengan
      // trigger asli sehingga tidak ada orakel enumerasi.
      if (record.decoy === true) {
        record.status = 'COMPLETED';
        record.otpSentAt = new Date().toISOString();
        await this.redis.set(OTP_TRIGGER(refCode), JSON.stringify(record), TRIGGER_TTL_SECONDS);
        return;
      }

      let otp: string;
      try {
        otp = await this.otpService.generatePhoneOtp(
          record.phoneNumber,
          OtpType.PHONE_LOGIN,
          'WHATSAPP',
          record.userId,
          {
            purpose: 'phone_login',
            deviceId: record.deviceId,
            triggerPurpose: record.purpose,
            refCode,
            // 03-#2: verifyPhoneOtp() untuk migrate_phone membaca metadata.userId.
            // Tanpa ini migrasi nomor HP selalu gagal Unauthorized.
            ...(record.userId ? { userId: record.userId } : {}),
          },
          undefined,
        );
      } catch (err) {
        this.logger.warn(
          `[OTP-TRIGGER] generatePhoneOtp gagal refCode=${refCode}: ${err instanceof Error ? err.message : String(err)}`,
        );
        record.status = 'FAILED';
        await this.redis.set(OTP_TRIGGER(refCode), JSON.stringify(record), TRIGGER_TTL_SECONDS);
        return;
      }

      const delivery = await this.otpGateway.sendOtp(record.phoneNumber, otp, 'WHATSAPP');
      if (!delivery.success) {
        this.logger.error(`[OTP-TRIGGER] pengiriman OTP gagal refCode=${refCode}: ${delivery.error}`);
        record.status = 'FAILED';
        await this.redis.set(OTP_TRIGGER(refCode), JSON.stringify(record), TRIGGER_TTL_SECONDS);
        await this.otpService.invalidatePhoneOtps(record.phoneNumber, OtpType.PHONE_LOGIN).catch(() => undefined);
        return;
      }
      record.status = 'COMPLETED';
      record.otpSentAt = new Date().toISOString();
      await this.redis.set(OTP_TRIGGER(refCode), JSON.stringify(record), TRIGGER_TTL_SECONDS);
      this.logger.log(`[OTP-TRIGGER] OTP terkirim via WA refCode=${refCode} purpose=${record.purpose}`);
    } catch (err) {
      this.logger.error(`[OTP-TRIGGER] webhook error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Helper ───────────────────────────────────────────────────────

  private async findUserByPhone(phoneNumber: string, phoneHash: string) {
    return this.prisma.user.findFirst({
      where: { OR: [{ phoneNumberHash: phoneHash }, { phoneNumber }] },
      select: { id: true, isActive: true, isBanned: true, lockedUntil: true },
    });
  }

  /**
   * Payload "decoy" anti-enumerasi: bentuknya identik dengan respons sukses
   * createTrigger DAN refCode-nya disimpan di Redis sebagai record berstatus
   * WAITING dengan flag `decoy` (TTL sama dengan trigger asli).
   *
   * 03-#3: versi sebelumnya tidak menyimpan apa pun sehingga polling status
   * decoy langsung EXPIRED vs WAITING untuk trigger asli — orakel enumerasi.
   * Sekarang polling decoy mengikuti siklus yang sama; webhook menyelesaikan
   * decoy TANPA mengirim OTP (lihat handleFonnteWebhook).
   */
  private async buildDecoyTriggerPayload(ctx: {
    phoneNumber: string;
    deviceId?: string;
    purpose: OtpTriggerPurpose;
  }): Promise<TriggerPayload> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TRIGGER_TTL_SECONDS * 1000);
    const record: TriggerRecord = {
      phoneNumber: ctx.phoneNumber,
      deviceId: ctx.deviceId,
      purpose: ctx.purpose,
      status: 'WAITING',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      decoy: true,
    };
    // Klaim atomik agar refCode decoy tidak bertabrakan dengan trigger asli.
    const refCode = await this.claimUniqueRefCode(record);
    const triggerText = `KAHADE ${refCode}`;
    return {
      refCode,
      triggerText,
      whatsappUrl: `https://wa.me/${KAHADE_WA_NUMBER}?text=${encodeURIComponent(triggerText)}`,
      expiresInSeconds: TRIGGER_TTL_SECONDS,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Membuat refCode unik dan mengklaimnya secara atomik (SET NX) dalam
   * satu langkah, sehingga dua request konkuren tidak bisa mendapatkan
   * kode yang sama lalu saling menimpa record trigger.
   */
  private async claimUniqueRefCode(record: TriggerRecord): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = randomBytes(REFCODE_BYTES).toString('hex').toUpperCase();
      const claimed = await this.redis.setNx(
        OTP_TRIGGER(code),
        JSON.stringify(record),
        TRIGGER_TTL_SECONDS,
      );
      if (claimed) return code;
    }
    throw new BadRequestException({
      code: ErrorCodes.TOO_MANY_REQUESTS,
      message: 'Gagal membuat kode referensi. Coba lagi.',
    });
  }
}
