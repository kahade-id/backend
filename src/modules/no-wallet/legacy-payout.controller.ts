import { Body, Controller, Get, HttpCode, Ip, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { LegacyPayoutService } from './legacy-payout.service';
import { EscrowDisbursementService } from './escrow-disbursement.service';
import { LegacyPayoutDto } from './dto/legacy-payout.dto';
import { EscrowDisbursementScope } from '@prisma/client';

/**
 * Payout satu arah saldo wallet lama → rekening bank via DANA.
 *
 * SENGAJA TIDAK memakai WalletKillSwitchGuard: endpoint ini justru jalur
 * keluarnya saldo lama saat WALLET_ENABLED=false. Tidak ada top-up /
 * transfer masuk dari jalur ini — hanya debit satu arah.
 */
@Controller('legacy-payout')
export class LegacyPayoutController {
  private readonly logger = new Logger(LegacyPayoutController.name);

  constructor(
    private readonly legacyPayout: LegacyPayoutService,
    private readonly escrowDisbursement: EscrowDisbursementService,
  ) {}

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Post()
  @HttpCode(200)
  // SYS-B-102: payout satu arah adalah pergerakan uang — wajib Idempotency-Key
  // (UUID v4) di header; double submit tidak men-debit ganda.
  //
  // P3: Endpoint ini SENGAJA dipertahankan sebagai jalur keluar saldo wallet
  // lama saat WALLET_ENABLED=false. Tidak ada pemanggil frontend aktif saat
  // ini, tetapi menonaktifkannya akan menjebak dana user yang memiliki saldo
  // lama. Jangan hapus tanpa migrasi saldo terlebih dahulu.
  // @deprecated Untuk saldo baru gunakan jalur disbursement standar;
  // endpoint ini hanya untuk migrasi saldo lama.
  @Idempotency()
  async request(
    @CurrentUser('sub') userId: string,
    @Body() dto: LegacyPayoutDto,
    @Ip() ip?: string,
  ) {
    // P3: observability — endpoint fund-movement tanpa pemanggil aktif
    this.logger.warn(`LEGACY_PAYOUT_REQUEST userId=${userId} amountSen=${dto.amountSen} ip=${ip ?? '-'}`);
    return this.legacyPayout.requestPayout(userId, dto, ip);
  }

  /**
   * Status pencairan dana (cashback, referral, escrow order, dll) untuk user.
   * Query param opsional: scope=CASHBACK|REFERRAL|ORDER_ESCROW|MILESTONE|DISPUTE_RELEASE
   */
  @UseGuards(UserThrottleGuard)
  @Get('disbursements')
  async getDisbursements(
    @CurrentUser('sub') userId: string,
    @Query('scope') scope?: string,
    @Query('limit') limit?: string,
  ) {
    const validScopes = Object.values(EscrowDisbursementScope) as string[];
    const parsedScope =
      scope && validScopes.includes(scope) ? (scope as EscrowDisbursementScope) : undefined;
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100) : 20;
    const items = await this.escrowDisbursement.getDisbursementsForUser(userId, {
      scope: parsedScope,
      limit: parsedLimit,
    });
    return { items };
  }
}
