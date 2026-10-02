import { Controller, Get, Post, Body, Param, Query, HttpCode } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PatunganService } from '../services/patungan.service';
import { CreatePatunganGroupDto, JoinPatunganDto, LinkPatunganOrderDto } from '../dto/commerce.dto';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../../common/dto/pagination.dto';
import { PatunganStatus } from '@prisma/client';
import { Public } from '../../../common/decorators/public.decorator';

@ApiTags('patungan')
@ApiBearerAuth('access-token')
@Controller('patungan')
export class PatunganController {
  constructor(private readonly service: PatunganService) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('groups')
  @ApiOperation({ summary: 'Host membuat grup patungan' })
  createGroup(@CurrentUser('sub') hostId: string, @Body() dto: CreatePatunganGroupDto) {
    return this.service.createGroup(hostId, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  // BFE-116: didokumentasikan publik — anonim boleh melihat daftar grup.
  @Public()
  @Get('groups')
  @ApiOperation({ summary: 'Daftar grup patungan (publik, bisa filter status)' })
  listGroups(@Query('status') status: PatunganStatus | undefined, @Query() pagination: PaginationDto) {
    return this.service.listGroups(pagination.page ?? 1, pagination.limit ?? 20, status);
  }

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @Get('groups/:id')
  @ApiOperation({ summary: 'Detail grup + agregat transparan (terkumpul, sisa, overfunding)' })
  getGroup(@Param('id') id: string) {
    return this.service.getGroupDetail(id);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('groups/:id/join')
  @ApiOperation({ summary: 'Join grup patungan (bayar via escrow order, ditautkan setelahnya)' })
  joinGroup(@CurrentUser('sub') userId: string, @Param('id') id: string, @Body() dto: JoinPatunganDto) {
    return this.service.joinGroup(userId, id, dto);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('participants/:participantId/link-order')
  @HttpCode(200)
  @ApiOperation({ summary: 'Tautkan escrow order yang sudah dibayar ke partisipasi' })
  linkOrder(
    @CurrentUser('sub') userId: string,
    @Param('participantId') participantId: string,
    @Body() dto: LinkPatunganOrderDto,
  ) {
    return this.service.linkOrder(userId, participantId, dto.orderId);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('participants/:participantId/leave')
  @HttpCode(200)
  @ApiOperation({ summary: 'Keluar dari grup patungan (hanya peserta PENDING)' })
  leaveGroup(@CurrentUser('sub') userId: string, @Param('participantId') participantId: string) {
    return this.service.leaveGroup(userId, participantId);
  }

  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post('groups/:id/initiate-release')
  @HttpCode(200)
  @ApiOperation({ summary: 'Host inisiasi pencairan → masa sanggah 24 jam' })
  initiateRelease(@CurrentUser('sub') hostId: string, @Param('id') id: string) {
    return this.service.initiateRelease(hostId, id);
  }
}
