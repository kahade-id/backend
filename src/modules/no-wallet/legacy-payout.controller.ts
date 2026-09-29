import { Body, Controller, HttpCode, Ip, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { LegacyPayoutService } from './legacy-payout.service';
import { LegacyPayoutDto } from './dto/legacy-payout.dto';

/**
 * Payout satu arah saldo wallet lama → rekening bank via DANA.
 *
 * SENGAJA TIDAK memakai WalletKillSwitchGuard: endpoint ini justru jalur
 * keluarnya saldo lama saat WALLET_ENABLED=false. Tidak ada top-up /
 * transfer masuk dari jalur ini — hanya debit satu arah.
 */
@Controller('legacy-payout')
export class LegacyPayoutController {
  constructor(private readonly legacyPayout: LegacyPayoutService) {}

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Post()
  @HttpCode(200)
  async request(
    @CurrentUser('sub') userId: string,
    @Body() dto: LegacyPayoutDto,
    @Ip() ip?: string,
  ) {
    return this.legacyPayout.requestPayout(userId, dto, ip);
  }
}
