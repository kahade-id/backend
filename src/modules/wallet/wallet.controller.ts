import { Controller, Get, Post, Body, Query, Param, Req, Res, ParseIntPipe, DefaultValuePipe, UseGuards, HttpCode } from '@nestjs/common';
import { Request, Response } from 'express';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ParseQueryStringPipe, ParseDateQueryPipe } from '../../common/pipes/parse-query-string.pipe';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WalletService } from './wallet.service';
import { WalletExportService } from './export.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { TopupDto } from './dto/topup.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { ConfirmWithdrawOtpDto } from './dto/confirm-withdraw-otp.dto';
import { ResendWithdrawOtpDto } from './dto/resend-withdraw-otp.dto';
import { SetPinDto, VerifyPinDto } from './dto/wallet-pin.dto';
import { ExportCsvDto } from './dto/export-csv.dto';
import { TransferDto } from './dto/transfer.dto';
import { formatWIBDate } from '../../common/utils/date.util';

@ApiTags('wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
export class WalletController {
  constructor(
    private walletService: WalletService,
    private walletExportService: WalletExportService,
  ) {}

  @Get()
  async getWallet(@CurrentUser('sub') userId: string): Promise<object> {
    return this.walletService.getWallet(userId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('transactions')
  async getTransactions(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
    @Query('type', new ParseQueryStringPipe('type', 50)) type?: string,
    @Query('from', new ParseDateQueryPipe('from')) from?: string,
    @Query('to', new ParseDateQueryPipe('to')) to?: string,
  ): Promise<object> {
    return this.walletService.getTransactions(userId, page, limit, type, from, to);
  }

  @Get('transactions/:txId')
  async getTransactionDetail(@CurrentUser('sub') userId: string, @Param('txId', ParseIdPipe) txId: string): Promise<object> {
    return this.walletService.getTransactionDetail(userId, txId);
  }

  @Post('topup')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Idempotency()
  async topup(@CurrentUser('sub') userId: string, @Body() dto: TopupDto): Promise<object> {
    return this.walletService.topup(userId, dto.amount, dto.method, dto.cardToken);
  }

  @Post('withdraw')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Idempotency()
  async withdraw(@CurrentUser('sub') userId: string, @Body() dto: WithdrawDto, @Req() req: Request): Promise<object> {
    return this.walletService.withdraw(userId, dto.amount, dto.bankAccountId, dto.pin, req.ip);
  }

  @Post('transfer')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Idempotency()
  @ApiOperation({ summary: 'Transfer funds to another KYC-verified user' })
  async transfer(@CurrentUser('sub') userId: string, @Body() dto: TransferDto, @Req() req: Request): Promise<object> {
    return this.walletService.transfer(userId, dto.recipientId, dto.amount, dto.pin, dto.note, req.ip);
  }

  @Get('transfer/lookup')
  @ApiOperation({ summary: 'Lookup a user for transfer by username or userId' })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async lookupTransferRecipient(
    @CurrentUser('sub') userId: string,
    @Query('q') query: string,
  ): Promise<object> {
    if (!query || query.trim().length < 2) {
      return { user: null };
    }
    const user = await this.walletService.lookupTransferRecipient(query.trim(), userId);
    return { user };
  }

  @Post('withdraw/confirm-otp')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Idempotency()
  async confirmWithdrawOtp(@CurrentUser('sub') userId: string, @Body() dto: ConfirmWithdrawOtpDto): Promise<object> {
    return this.walletService.confirmWithdrawOtp(userId, dto.txId, dto.otp);
  }

  @Post('withdraw/resend-otp')
  @HttpCode(200)
  @ApiOperation({ summary: 'Resend OTP for pending withdrawal (60s cooldown)' })
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Idempotency()
  async resendWithdrawOtp(@CurrentUser('sub') userId: string, @Body() dto: ResendWithdrawOtpDto, @Req() req: Request): Promise<object> {
    return this.walletService.resendWithdrawOtp(userId, dto.txId, req.ip);
  }

  @Post('withdraw/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a pending withdrawal (PENDING_OTP only)' })
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Idempotency()
  async cancelWithdraw(@CurrentUser('sub') userId: string, @Body('txId', ParseIdPipe) txId: string): Promise<object> {
    return this.walletService.cancelPendingWithdrawal(userId, txId);
  }

  @Get('topup-status/:paymentTxId')
  @ApiOperation({ summary: 'Poll the status of a previously initiated top-up' })
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async getTopupStatus(
    @CurrentUser('sub') userId: string,
    @Param('paymentTxId', ParseIdPipe) paymentTxId: string,
  ): Promise<{ status: string; txId: string; amount: number }> {
    return this.walletService.getTopupStatus(userId, paymentTxId);
  }

  @Get('topup-history')
  @ApiOperation({ summary: 'Get topup transaction history' })
  async getTopupHistory(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
    @Query('from', new ParseDateQueryPipe('from')) from?: string,
    @Query('to', new ParseDateQueryPipe('to')) to?: string,
  ): Promise<object> {
    return this.walletService.getTransactions(userId, page, limit, 'TOP_UP', from, to);
  }

  @Get('withdraw-history')
  @ApiOperation({ summary: 'Get withdrawal transaction history' })
  async getWithdrawHistory(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
    @Query('from', new ParseDateQueryPipe('from')) from?: string,
    @Query('to', new ParseDateQueryPipe('to')) to?: string,
  ): Promise<object> {
    return this.walletService.getTransactions(userId, page, limit, 'WITHDRAW', from, to);
  }

  @Post('set-pin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set or change wallet PIN' })
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  async setPin(
    @CurrentUser('sub') userId: string,
    @Body() dto: SetPinDto,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    return this.walletService.setPin(userId, dto.pin, dto.currentPin, dto.password, req.ip);
  }

  @Post('verify-pin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify wallet PIN' })
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  async verifyPin(
    @CurrentUser('sub') userId: string,
    @Body() dto: VerifyPinDto,
    @Req() req: Request,
  ): Promise<{ valid: boolean }> {
    return this.walletService.verifyPin(userId, dto.pin, req.ip);
  }

  @Public()
  @Get('payment-methods')
  @ApiOperation({ summary: 'List available payment methods with fees' })
  async getPaymentMethods(): Promise<object> {
    return this.walletService.getPaymentMethods();
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Get('export')
  @ApiOperation({ summary: 'Export wallet transactions as CSV or XLSX' })
  async exportTransactions(
    @CurrentUser('sub') userId: string,
    @Query() query: ExportCsvDto,
    @Res() res: Response,
  ): Promise<void> {
    const format = query.format || 'csv';
    const dateStr = formatWIBDate();

    if (format === 'xlsx') {
      const buffer = await this.walletExportService.exportTransactionsXlsx(userId, query.from, query.to, query.types);
      const filename = `kahade_transactions_${dateStr}.xlsx`;
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buffer.length.toString(),
      });
      res.send(buffer);
      return;
    }

    const filename = `kahade_transactions_${dateStr}.csv`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Transfer-Encoding': 'chunked',
    });
    const found = await this.walletExportService.streamTransactionsCsv(userId, res, query.from, query.to, query.types);
    if (!found) {
      res.status(200);
    }
    res.end();
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Get('export/csv')
  @ApiOperation({ summary: 'Export wallet transactions as CSV' })
  async exportCsv(
    @CurrentUser('sub') userId: string,
    @Query() query: ExportCsvDto,
  ): Promise<{ csv: string; filename: string }> {
    const csv = await this.walletExportService.exportTransactionsCsv(userId, query.from, query.to, query.types);
    const filename = `kahade_transactions_${formatWIBDate()}.csv`;
    return { csv, filename };
  }

  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Get('export/pdf')
  @ApiOperation({ summary: 'Export wallet transactions as printable HTML report' })
  async exportPdf(
    @CurrentUser('sub') userId: string,
    @Query() query: ExportCsvDto,
  ): Promise<{ html: string; filename: string }> {
    const html = await this.walletExportService.exportTransactionsHtml(userId, query.from, query.to);
    const filename = `kahade_report_${formatWIBDate()}.html`;
    return { html, filename };
  }
}
