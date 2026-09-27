/**
 * GAP-D retur — endpoint buyer/seller. Prefix global /v1 → /v1/returns.
 *
 * Auth: JwtAuthGuard global (pola modul lain). Idempotency-Key diwajibkan
 * untuk mutasi via @Idempotency() (pola disputes).
 */
import {
  Controller, Get, Post, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ReturnsService } from './returns.service';
import { ReturnsRefundService } from './returns-refund.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import {
  CreateReturnDto,
  SellerRespondDto,
  AddReturnNoteDto,
  ShipReturnDto,
  ConfirmReceiptDto,
  EscalateReturnDto,
  ListReturnsQueryDto,
  ResolveReturnDto,
} from './dto/returns.dto';

@ApiTags('returns')
@ApiBearerAuth('access-token')
@Controller('returns')
export class ReturnsController {
  constructor(
    private returnsService: ReturnsService,
    private refundService: ReturnsRefundService,
  ) {}

  @Get('eligibility')
  @ApiOperation({ summary: 'Cek kelayakan retur + batas akhir pengajuan (dihitung server)' })
  async eligibility(
    @CurrentUser('sub') userId: string,
    @Query('orderId') orderId: string,
  ) {
    return this.returnsService.getEligibility(orderId, userId);
  }

  @Get('my')
  @ApiOperation({ summary: 'Daftar retur saya (buyer/seller)' })
  async listMy(@CurrentUser('sub') userId: string, @Query() query: ListReturnsQueryDto) {
    return this.returnsService.listReturns(userId, query);
  }

  @Get('order/:orderId')
  @ApiOperation({ summary: 'Riwayat retur pada satu pesanan (G224)' })
  async listByOrder(@CurrentUser('sub') userId: string, @Param('orderId') orderId: string) {
    return this.returnsService.listByOrder(orderId, userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detail retur + timeline + negosiasi' })
  async detail(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.returnsService.getDetail(id, userId);
  }

  @Post()
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Idempotency()
  @ApiOperation({ summary: 'Buyer mengajukan retur (G203)' })
  async create(@CurrentUser('sub') userId: string, @Body() dto: CreateReturnDto) {
    return this.returnsService.createReturn(userId, dto);
  }

  @Post(':id/notes')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Tambah catatan negosiasi dua pihak (G216)' })
  async addNote(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: AddReturnNoteDto,
    @Query('as') asRole?: string,
  ) {
    // Peran diambil dari query eksplisit agar buyer/seller memakai endpoint sama.
    const role = asRole === 'seller' ? 'SELLER' : 'BUYER';
    return this.returnsService.addNote(id, userId, dto, role as 'BUYER' | 'SELLER');
  }

  @Post(':id/clarify')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Buyer menjawab klarifikasi seller' })
  async clarify(@CurrentUser('sub') userId: string, @Param('id') id: string, @Body() dto: AddReturnNoteDto) {
    return this.returnsService.buyerClarify(id, userId, dto);
  }

  @Post(':id/cancel')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Buyer membatalkan pengajuan retur' })
  async cancel(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.returnsService.buyerCancel(id, userId);
  }

  @Post(':id/ship')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Buyer melaporkan resi kirim balik (G213)' })
  async ship(@CurrentUser('sub') userId: string, @Param('id') id: string, @Body() dto: ShipReturnDto) {
    return this.returnsService.submitShipment(id, userId, dto);
  }

  @Post(':id/escalate')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Eskalasi ke sengketa — link case existing, tanpa case ganda (G217)' })
  async escalate(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: EscalateReturnDto,
    @Query('as') asRole?: string,
  ) {
    const role = asRole === 'seller' ? 'SELLER' : 'BUYER';
    return this.returnsService.escalateToDispute(id, userId, role as 'BUYER' | 'SELLER', dto.reason);
  }

  // ---------------------------------------------------------- aksi seller
  @Post(':id/review')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Seller mulai meninjau pengajuan' })
  async startReview(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.returnsService.sellerStartReview(id, userId);
  }

  @Post(':id/respond')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Seller: terima / tolak+alasan / minta klarifikasi (G207)' })
  async respond(@CurrentUser('sub') userId: string, @Param('id') id: string, @Body() dto: SellerRespondDto) {
    return this.returnsService.sellerRespond(id, userId, dto);
  }

  @Post(':id/receive')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Seller mengonfirmasi barang retur diterima (G215)' })
  async receive(@CurrentUser('sub') userId: string, @Param('id') id: string, @Body() dto: ConfirmReceiptDto) {
    return this.returnsService.confirmReceipt(id, userId, dto);
  }

  @Post(':id/resolve')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Finalisasi penyelesaian: refund (idempoten) / tukar / perbaiki (G209–G211)' })
  async resolve(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    // SEC-203: DTO tervalidasi — outcome tak dikenal ditolak 400 oleh
    // ValidationPipe, tidak lagi jatuh diam-diam ke REPAIR.
    @Body() dto: ResolveReturnDto,
    @Query('as') asRole?: string,
  ) {
    const role = asRole === 'buyer' ? 'BUYER' : 'SELLER';
    return this.returnsService.resolveReturn(id, userId, role as 'BUYER' | 'SELLER', dto.outcome, dto.note);
  }
}
