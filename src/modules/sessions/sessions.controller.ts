import { Controller, Get, Delete, Param, Query, UseGuards, DefaultValuePipe, ParseIntPipe } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SessionsService } from './sessions.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';

@ApiTags('sessions')
@ApiBearerAuth('access-token')
@Controller('sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
  constructor(private sessionsService: SessionsService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @UseGuards(UserThrottleGuard)
  @Get()
  async getActiveSessions(
    @CurrentUser('sub') userId: string,
    @CurrentUser('sessionId') currentSessionId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe, new ClampLimitPipe(50)) limit: number,
  ): Promise<{ sessions: Array<Record<string, unknown>>; total: number; page: number; limit: number }> {
    return this.sessionsService.getActiveSessions(userId, currentSessionId, page, limit);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Delete('others')
  async revokeAllOtherSessions(
    @CurrentUser('sub') userId: string,
    @CurrentUser('sessionId') currentSessionId: string,
  ): Promise<{ count: number }> {
    return this.sessionsService.revokeAllOtherSessions(userId, currentSessionId);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Delete(':sessionId')
  async revokeSession(
    @CurrentUser('sub') userId: string,
    @Param('sessionId', ParseIdPipe) sessionId: string,
  ): Promise<{ message: string }> {
    return this.sessionsService.revokeSession(userId, sessionId);
  }
}
