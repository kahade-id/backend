import { Controller, Get, Post, Body, Param, Query, ParseIntPipe, DefaultValuePipe, UseGuards } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SupportService } from './support.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateTicketDto, ReplyTicketDto } from './dto/create-ticket.dto';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';

@ApiTags('support')
@ApiBearerAuth('access-token')
@Controller('support')
export class SupportController {
  constructor(private supportService: SupportService) {}

  @Get('tickets')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'List my support tickets' })
  async getTickets(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe(50)) limit: number,
  ): Promise<object> {
    return this.supportService.getTickets(userId, page, limit);
  }

  @UseGuards(UserThrottleGuard)
  @Post('tickets')
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @ApiOperation({ summary: 'Create a support ticket' })
  async createTicket(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateTicketDto,
  ): Promise<object> {
    return this.supportService.createTicket(userId, dto);
  }

  @Get('tickets/:ticketId')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Get ticket detail' })
  async getTicketDetail(
    @CurrentUser('sub') userId: string,
    @Param('ticketId', ParseIdPipe) ticketId: string,
  ): Promise<object> {
    return this.supportService.getTicketDetail(userId, ticketId);
  }

  @UseGuards(UserThrottleGuard)
  @Post('tickets/:ticketId/reply')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Reply to a ticket' })
  async replyToTicket(
    @CurrentUser('sub') userId: string,
    @Param('ticketId', ParseIdPipe) ticketId: string,
    @Body() dto: ReplyTicketDto,
  ): Promise<object> {
    return this.supportService.replyToTicket(userId, ticketId, dto);
  }
}
