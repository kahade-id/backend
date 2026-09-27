import { Controller, Get, Post, Body, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ReceiptsService } from './receipts.service';
import { CreateReceiptTokenDto } from './dto/create-receipt-token.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';

@ApiTags('receipts')
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Post('token')
  @ApiBearerAuth('access-token')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary: 'Terbitkan token struk anti-manipulasi untuk salah satu transaksi milik user',
  })
  @ApiResponse({ status: 201, description: 'Token + verifyUrl berhasil diterbitkan' })
  @ApiResponse({ status: 404, description: 'Record tidak ditemukan atau bukan milik user (fail-closed)' })
  async createToken(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateReceiptTokenDto,
  ): Promise<{ token: string; verifyUrl: string }> {
    return this.receiptsService.createToken(userId, dto);
  }

  @Get('verify/:token')
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({
    summary: 'Verifikasi token struk (publik, rate-limited). Mengembalikan JSON, atau HTML bila Accept: text/html.',
  })
  @ApiResponse({ status: 200, description: 'Struk valid' })
  @ApiResponse({ status: 404, description: 'Token tidak valid/kedaluwarsa/record hilang — { valid: false }' })
  async verify(
    @Param('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<object | string> {
    const result = await this.receiptsService.verifyToken(token);
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (wantsHtml) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!result.valid) res.status(404);
      return this.receiptsService.renderReceiptHtml(result);
    }
    if (!result.valid) res.status(404);
    return result;
  }
}
