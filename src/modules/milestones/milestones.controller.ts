// GAP-C (G176–G200): endpoint user untuk order escrow bertahap.
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MilestonesService } from './milestones.service';
import {
  ChangeRequestDto,
  CreateMilestonesDto,
  EvidenceDto,
  ExtendDeadlineDto,
  RevisionDto,
  UpdateMilestoneDto,
} from './dto/milestone.dto';

@ApiTags('milestones')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller()
export class MilestonesController {
  constructor(private readonly milestones: MilestonesService) {}

  @Get('orders/:orderId/milestones')
  list(@Param('orderId') orderId: string, @CurrentUser('sub') userId: string) {
    return this.milestones.getOrderMilestones(orderId, userId);
  }

  @Post('orders/:orderId/milestones')
  @HttpCode(201)
  create(
    @Param('orderId') orderId: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateMilestonesDto,
  ) {
    return this.milestones.createMilestones(orderId, userId, dto);
  }

  @Post('orders/:orderId/milestones/cancel-remaining')
  @HttpCode(200)
  cancelRemaining(@Param('orderId') orderId: string, @CurrentUser('sub') userId: string) {
    return this.milestones.cancelRemaining(orderId, userId);
  }

  @Get('milestones/:id')
  detail(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    return this.milestones.getMilestone(id, userId);
  }

  @Patch('milestones/:id')
  update(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: UpdateMilestoneDto,
  ) {
    return this.milestones.updateMilestone(id, userId, dto);
  }

  @Post('milestones/:id/change-request')
  @HttpCode(200)
  changeRequest(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: ChangeRequestDto,
  ) {
    return this.milestones.requestChange(id, userId, dto);
  }

  @Post('milestones/:id/approve-change')
  @HttpCode(200)
  approveChange(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    return this.milestones.approveChange(id, userId);
  }

  @Post('milestones/:id/submit')
  @HttpCode(200)
  submit(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    return this.milestones.submitMilestone(id, userId);
  }

  @Post('milestones/:id/evidence')
  @HttpCode(201)
  addEvidence(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: EvidenceDto,
  ) {
    return this.milestones.addEvidence(id, userId, dto);
  }

  @Post('milestones/:id/accept')
  @HttpCode(200)
  accept(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    return this.milestones.acceptMilestone(id, userId);
  }

  @Post('milestones/:id/release')
  @HttpCode(200)
  release(@Param('id') id: string, @CurrentUser('sub') userId: string) {
    return this.milestones.releaseMilestone(id, userId);
  }

  @Post('milestones/:id/request-revision')
  @HttpCode(200)
  requestRevision(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: RevisionDto,
  ) {
    return this.milestones.requestRevision(id, userId, dto);
  }

  @Post('milestones/:id/extend-deadline')
  @HttpCode(200)
  extendDeadline(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() dto: ExtendDeadlineDto,
  ) {
    return this.milestones.extendDeadline(id, userId, dto);
  }

  @Post('milestones/:id/dispute')
  @HttpCode(200)
  dispute(
    @Param('id') id: string,
    @CurrentUser('sub') userId: string,
    @Body() body: { reason: string },
  ) {
    return this.milestones.openMilestoneDispute(id, userId, body?.reason ?? '');
  }
}
