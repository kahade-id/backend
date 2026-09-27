import { Controller, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InstallmentsService } from '../services/installments.service';
import { CreateInstallmentPlanDto } from '../dto/commerce.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';

@ApiTags('commerce-installments')
@ApiBearerAuth('access-token')
@Controller('commerce/installments')
export class InstallmentsController {
  constructor(private readonly service: InstallmentsService) {}

  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post('orders/:orderId/plan')
  @ApiOperation({
    summary: 'Buat skema DP + cicilan (opt-in) memakai modul milestone — hanya seller, sebelum order dibayar',
  })
  createPlan(
    @CurrentUser('sub') sellerId: string,
    @Param('orderId') orderId: string,
    @Body() dto: CreateInstallmentPlanDto,
  ) {
    return this.service.createInstallmentPlan(sellerId, orderId, dto);
  }
}
