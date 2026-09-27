import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import { ParseIdPipe } from '../../../common/pipes/parse-id.pipe';
import { Idempotency } from '../../../common/decorators/idempotency.decorator';
import { Throttle } from '@nestjs/throttler';
import { UserThrottleGuard } from '../../../common/guards/user-throttle.guard';
import { CreateHighlightDto, UpdateHighlightDto } from './dto/highlight.dto';
import { HighlightsService } from './highlights.service';

/**
 * Batch 19 TIM A (item 4) — CRUD highlight etalase milik sendiri.
 * Daftar highlight publik per username ada di `GET /v1/users/:username/highlights`
 * (UsersController), bukan di sini.
 */
@ApiTags('Showcase Highlights')
@ApiBearerAuth()
@Controller('highlights')
@UseGuards(UserThrottleGuard)
@Throttle({ default: { ttl: 60000, limit: 60 } })
export class HighlightsController {
  constructor(private highlightsService: HighlightsService) {}

  @Post()
  @Idempotency()
  @ApiOperation({
    summary: 'Create a showcase highlight',
    description:
      'Maks ' +
      '20 highlight/user dan 50 produk/highlight. Semua productIds harus milikmu dan belum dihapus; ' +
      'coverMediaId (opsional) harus media milikmu.',
  })
  async createHighlight(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateHighlightDto,
  ): Promise<object> {
    return this.highlightsService.createHighlight(userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List my showcase highlights' })
  async listMyHighlights(@CurrentUser('sub') userId: string): Promise<object> {
    return this.highlightsService.listMyHighlights(userId);
  }

  @Get(':highlightId')
  @ApiOperation({ summary: 'Get my highlight detail' })
  async getHighlight(
    @CurrentUser('sub') userId: string,
    @Param('highlightId', ParseIdPipe) highlightId: string,
  ): Promise<object> {
    return this.highlightsService.getHighlight(userId, highlightId);
  }

  @Patch(':highlightId')
  @Idempotency()
  @ApiOperation({
    summary: 'Update my highlight',
    description:
      'productIds bila diisi me-REPLACE penuh daftar produk. ' +
      'coverMediaId=null menghapus cover (kembali ke fallback otomatis).',
  })
  async updateHighlight(
    @CurrentUser('sub') userId: string,
    @Param('highlightId', ParseIdPipe) highlightId: string,
    @Body() dto: UpdateHighlightDto,
  ): Promise<object> {
    return this.highlightsService.updateHighlight(userId, highlightId, dto);
  }

  @Delete(':highlightId')
  @HttpCode(HttpStatus.OK)
  @Idempotency()
  @ApiOperation({ summary: 'Delete my highlight (hard delete)' })
  async deleteHighlight(
    @CurrentUser('sub') userId: string,
    @Param('highlightId', ParseIdPipe) highlightId: string,
  ): Promise<{ deleted: boolean }> {
    return this.highlightsService.deleteHighlight(userId, highlightId);
  }
}
