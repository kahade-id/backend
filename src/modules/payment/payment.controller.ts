import {
  Controller,
  Post,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiBody } from '@nestjs/swagger';
import { Request } from 'express';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Public } from '../../common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { PaymentService } from './payment.service';
import { MidtransNotificationDto } from './dto/midtrans-notification.dto';
import * as ErrorCodes from '../../common/constants/error-codes';

@ApiTags('payments')
@Controller('payments')
export class PaymentController {
  constructor(private paymentService: PaymentService) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 100 } })
  @Post('midtrans-webhook')
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: MidtransNotificationDto })
  async midtransWebhook(
    // PAY-021: the body is deliberately typed inline so the *global* ValidationPipe
    // (whitelist + forbidNonWhitelisted, main.ts) skips it — an inline type has no
    // metatype. Midtrans notifications legitimately carry many fields beyond the ones
    // we consume (transaction_time, merchant_id, currency, settlement_time, va_numbers,
    // masked_card, bank, approval_code, ...) and the set grows per payment channel, so
    // global whitelisting would 400 every real webhook while stripping the extra fields
    // from the WebhookLog audit payload. Validation is therefore applied explicitly
    // below against the same DTO, and the untouched body is what gets persisted.
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ): Promise<{ message: string }> {
    const notification = plainToInstance(MidtransNotificationDto, body ?? {}, {
      excludeExtraneousValues: false,
    });
    const errors = validateSync(notification, {
      whitelist: false,
      forbidNonWhitelisted: false,
      skipMissingProperties: false,
    });
    if (errors.length > 0) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: 'Invalid Midtrans webhook payload',
      });
    }

    // PAY-014: req.ip respects Express 'trust proxy' setting (configured in main.ts
    // via TRUSTED_PROXY_CIDR) which correctly parses X-Forwarded-For from trusted proxies.
    const sourceIp = req.ip || req.socket?.remoteAddress || '';
    return this.paymentService.handleMidtransWebhook(
      { ...body, ...notification } as MidtransNotificationDto,
      sourceIp,
    );
  }
}
