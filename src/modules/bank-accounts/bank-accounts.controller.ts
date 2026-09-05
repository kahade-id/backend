import { Controller, Get, Post, Delete, Param, Body, UseGuards, HttpCode } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BankAccountsService } from './bank-accounts.service';
import { AddBankAccountDto } from './dto/add-bank-account.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PhoneVerifiedGuard } from '../../common/guards/phone-verified.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserJwtPayload } from '../../common/types/jwt-payload.types';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { Idempotency } from '../../common/decorators/idempotency.decorator';

@ApiTags('bank-accounts')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PhoneVerifiedGuard)
@Controller('bank-accounts')
export class BankAccountsController {
  constructor(private readonly service: BankAccountsService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get()
  list(@CurrentUser() user: UserJwtPayload): Promise<{ bankAccounts: Array<Record<string, unknown>> }> {
    return this.service.listBankAccounts(user.sub);
  }

  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Post()
  add(@CurrentUser() user: UserJwtPayload, @Body() dto: AddBankAccountDto): Promise<Record<string, unknown>> {
    return this.service.addBankAccount(
      user.sub, dto.bankCode, dto.bankName, dto.accountNumber, dto.accountName,
    );
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Post(':id/set-primary')
  @HttpCode(200)
  setPrimary(@CurrentUser() user: UserJwtPayload, @Param('id', ParseIdPipe) id: string): Promise<Record<string, unknown>> {
    return this.service.setPrimaryBankAccount(user.sub, id);
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Delete(':id')
  delete(@CurrentUser() user: UserJwtPayload, @Param('id', ParseIdPipe) id: string): Promise<{ message: string }> {
    return this.service.deleteBankAccount(user.sub, id);
  }
}
