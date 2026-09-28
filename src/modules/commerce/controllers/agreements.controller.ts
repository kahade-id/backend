import { Controller, Get, Post, Body, Param, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AgreementsService } from '../services/agreements.service';
import { CreateAgreementDto } from '../dto/commerce.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';

@ApiTags('commerce-agreements')
@ApiBearerAuth('access-token')
@Controller('commerce/agreements')
export class AgreementsController {
  constructor(private readonly service: AgreementsService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post()
  @ApiOperation({ summary: 'Buat SPK ringan untuk order (salah satu pihak)' })
  create(@CurrentUser('sub') userId: string, @Body() dto: CreateAgreementDto) {
    return this.service.createAgreement(userId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('orders/:orderId')
  @ApiOperation({ summary: 'Lihat SPK order (pihak order)' })
  getOne(@CurrentUser('sub') userId: string, @Param('orderId') orderId: string) {
    return this.service.getAgreement(userId, orderId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('orders/:orderId/agree')
  @HttpCode(200)
  @ApiOperation({ summary: 'Tap setuju SPK (pihak yang belum setuju)' })
  agree(@CurrentUser('sub') userId: string, @Param('orderId') orderId: string) {
    return this.service.agree(userId, orderId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('orders/:orderId/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Batalkan SPK (sebelum disetujui kedua pihak)' })
  cancel(@CurrentUser('sub') userId: string, @Param('orderId') orderId: string) {
    return this.service.cancelAgreement(userId, orderId);
  }
}
