import {
  Controller, Get, Post, Put, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ScheduledWithdrawalService } from './scheduled-withdrawal.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateScheduleDto } from './dto/create-schedule.dto';
import { UpdateScheduleDto } from './dto/update-schedule.dto';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { Idempotency } from '../../common/decorators/idempotency.decorator';

@ApiTags('withdrawals')
@ApiBearerAuth('access-token')
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(private scheduledWithdrawalService: ScheduledWithdrawalService) {}

  @Post('schedules')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @ApiOperation({ summary: 'Create a scheduled withdrawal' })
  async createSchedule(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateScheduleDto,
  ): Promise<object> {
    return this.scheduledWithdrawalService.createSchedule(userId, dto);
  }

  @Get('schedules')
  @ApiOperation({ summary: 'Get my scheduled withdrawals' })
  async getSchedules(@CurrentUser('sub') userId: string): Promise<object[]> {
    return this.scheduledWithdrawalService.getSchedules(userId);
  }

  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Put('schedules/:scheduleId')
  @ApiOperation({ summary: 'Update a scheduled withdrawal' })
  async updateSchedule(
    @CurrentUser('sub') userId: string,
    @Param('scheduleId', ParseIdPipe) scheduleId: string,
    @Body() dto: UpdateScheduleDto,
  ): Promise<object> {
    return this.scheduledWithdrawalService.updateSchedule(userId, scheduleId, dto);
  }

  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @Delete('schedules/:scheduleId')
  @ApiOperation({ summary: 'Deactivate a scheduled withdrawal' })
  async deleteSchedule(
    @CurrentUser('sub') userId: string,
    @Param('scheduleId', ParseIdPipe) scheduleId: string,
  ): Promise<{ message: string }> {
    return this.scheduledWithdrawalService.deleteSchedule(userId, scheduleId);
  }
}
