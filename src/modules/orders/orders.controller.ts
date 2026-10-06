import {
  Controller, Get, Post, Put, Body, Query, Param, Req,
  ParseIntPipe, DefaultValuePipe, HttpCode, UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ParseTokenPipe } from '../../common/pipes/parse-token.pipe';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';
import { OrderStateService, ConfirmOrderResult, PayOrderResult, CompleteOrderResult, CancelOrderResult } from './order-state.service';
import { OrderExtensionsService } from './order-extensions.service';
import { OrderLinksService } from './order-links.service';
import { DeliveryProofService } from './delivery-proof.service';
import { InvoiceService } from './invoice.service';
import { ReceiptService } from './receipt.service';
import { OrderQrisPaymentService, OrderQrisPaymentResult } from '../payment/order-qris-payment.service';
import { DanaDirectPaymentService, DanaDirectPayResult, listDanaDirectPaymentMethods, DanaPaymentMethodInfo } from '../no-wallet/dana-direct-payment.service';
import { DanaDirectPayDto } from '../no-wallet/dto/dana-direct-pay.dto';
import { WalletKillSwitchGuard } from '../wallet-mode/wallet-kill-switch.guard';
import { DisputesService } from '../disputes/disputes.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateOrderLinkDto } from './dto/create-order-link.dto';
import { AcceptOrderLinkDto } from './dto/accept-order-link.dto';
import { GetOrdersQueryDto } from './dto/get-orders-query.dto';
import {
  CalculateFeeDto,
  ConfirmOrderDto,
  UpdateShippingDto,
  RequestExtensionDto,
  RespondExtensionDto,
  CancelOrderDto,
  SubmitDisputeDto,
  ValidateCounterpartDto,
  PayOrderDto,
  ConfirmReceiptDto,
} from './dto/order-actions.dto';
import { ConfirmDeliveryDto, SubmitDeliveryProofDto, RejectDeliveryDto } from './dto/delivery-proof.dto';
import { extractLocationContext } from '../action-location/action-location.util';

@ApiTags('orders')
@ApiBearerAuth('access-token')
@Controller('orders')
export class OrdersController {
  constructor(
    private ordersService: OrdersService,
    private orderStateService: OrderStateService,
    private orderExtensionsService: OrderExtensionsService,
    private orderLinksService: OrderLinksService,
    private deliveryProofService: DeliveryProofService,
    private invoiceService: InvoiceService,
    private receiptService: ReceiptService,
    private orderQrisPaymentService: OrderQrisPaymentService,
    private danaDirectPaymentService: DanaDirectPaymentService,
    private disputesService: DisputesService,
  ) {}

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('summary')
  async getOrderSummary(@CurrentUser('sub') userId: string): Promise<{
    asBuyer: { count: number; totalValue: number };
    asSeller: { count: number; totalValue: number };
    inDispute: number;
    pendingExtensions: number;
  }> {
    return this.ordersService.getOrderSummary(userId);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Get('average-durations')
  @ApiOperation({ summary: 'Get average duration per status transition from completed orders' })
  async getAverageDurations(): Promise<Record<string, number>> {
    return this.ordersService.getAverageDurations();
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('calculate-fee')
  @HttpCode(200)
  async calculateFee(
    @CurrentUser('sub') userId: string,
    @Body() dto: CalculateFeeDto,
  ): Promise<{
    orderValue: number;
    feeRate: number;
    feeAmount: number;
    buyerFeeAmount: number;
    sellerFeeAmount: number;
    buyerPayAmount: number;
    sellerReceiveAmount: number;
    voucherDiscount: number;
    voucherCashback: number;
    membershipRankDiscount: number;
    isKahadePlusApplied: boolean;
  }> {
    return this.ordersService.calculateFee(dto, userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post('validate-counterpart')
  @HttpCode(200)
  async validateCounterpart(
    @CurrentUser('sub') userId: string,
    @Body() dto: ValidateCounterpartDto,
  ): Promise<{
    user: {
      username: string | null;
      fullName: string | null;
      avatarUrl: string | null;
      isKycVerified: boolean;
      membershipRank: string;
      avgRating: unknown;
    } | null;
    isBlocked: boolean;
    canCreateOrder?: boolean;
    reason?: string;
  }> {
    return this.ordersService.validateCounterpart(userId, dto.username);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 20 } })
  @Post()
  @HttpCode(201)
  @Idempotency()
  async createOrder(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateOrderDto,
    @Req() req: Request,
  ): Promise<{
    orderId: string;
    status: string;
    feeCalculation: {
      feeRate: number;
      feeAmount: number;
      buyerFeeAmount: number;
      sellerFeeAmount: number;
      buyerPayAmount: number;
      sellerReceiveAmount: number;
      voucherDiscount: number;
      voucherCashback: number;
      membershipRankDiscount: number;
    };
    confirmationDeadlineAt: Date | null;
  }> {
    return this.ordersService.createOrder(userId, dto, extractLocationContext(req, dto));
  }

  @Get()
  async getOrders(
    @CurrentUser('sub') userId: string,
    @Query() query: GetOrdersQueryDto,
  ): Promise<{
    orders: {
      orderId: string;
      orderNumber: string;
      title: string;
      description: string;
      status: string;
      orderType: string;
      // TX-UNIFIED-V2 (2026-10-06): 3 dimensi baru.
      fulfillment: string;
      participantMode: string;
      category: string;
      orderValue: number;
      buyerPayAmount: number;
      sellerReceiveAmount: number;
      buyer: { userId: string; username: string | null; fullName: string | null; avatarUrl: string | null };
      seller: { userId: string; username: string | null; fullName: string | null; avatarUrl: string | null };
      role: 'BUYER' | 'SELLER';
      createdAt: Date;
    }[];
    // BD-008: tanpa COUNT — `total` dihapus; klien pakai hasNext/totalPages.
    hasNext: boolean;
    totalPages: number;
    page: number;
    limit: number;
  }> {
    return this.ordersService.getOrders(userId, query.page, query.limit, query.status as OrderStatus | undefined, query.role, query.search, query.from, query.to, query.sortBy, query.sortOrder, query.kind, query.fulfillment, query.participantMode, query.category);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':orderId')
  async getOrderDetail(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ order: object }> {
    return this.ordersService.getOrderDetail(userId, orderId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Post(':orderId/confirm')
  @Idempotency()
  @HttpCode(200)
  async confirmOrder(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: ConfirmOrderDto,
  ): Promise<ConfirmOrderResult> {
    return this.orderStateService.handleConfirmAction(orderId, userId, dto.action, dto.reason);
  }

  @UseGuards(UserThrottleGuard, WalletKillSwitchGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post(':orderId/pay')
  @Idempotency()
  async payOrder(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: PayOrderDto,
    @Req() req: Request,
  ): Promise<PayOrderResult> {
    return this.orderStateService.handlePayOrder(orderId, userId, dto.pin, req.ip, extractLocationContext(req, dto));
  }

  @UseGuards(UserThrottleGuard, WalletKillSwitchGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post(':orderId/pay-qris')
  @Idempotency()
  @HttpCode(200)
  async initiateQrisOrderPayment(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<OrderQrisPaymentResult> {
    return this.orderQrisPaymentService.initiate(orderId, userId);
  }

  /**
   * Misi tanpa-wallet (BI-safe): checkout escrow LANGSUNG via DANA.
   * Buyer bebas pilih metode (QRIS / VA bank / DANA Balance) — diteruskan
   * ke DANA, bukan hardcode QRIS. Tidak ada top-up, tidak sentuh wallet.
   */
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  // MFE-018: endpoint LEGACY — pasangan kanonis adalah POST /payments +
  // GET /dana-payment-status. DITANDAI DEPRECATED (OpenAPI + komentar):
  // JANGAN dihapus (klien lama masih bisa memanggil), tetapi semua kode baru
  // wajib memakai pasangan kanonis.
  @Post(':orderId/pay-dana')
  @Idempotency()
  @HttpCode(200)
  @ApiOperation({
    summary: '[DEPRECATED] Bayar escrow langsung via DANA (mode tanpa wallet)',
    description:
      'DEPRECATED — pakai POST /v1/orders/{orderId}/payments (kontrak kanonis). ' +
      'Endpoint ini dipertahankan untuk kompatibilitas klien lama. ' +
      'Membuat order DANA (QRIS/VA/Balance sesuai payKind). Buyer bayar ke DANA; ' +
      'webhook finish-notify mendanai escrow tanpa lewat wallet internal.',
    deprecated: true,
  })
  async initiateDanaDirectPayment(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: DanaDirectPayDto,
  ): Promise<DanaDirectPayResult> {
    return this.danaDirectPaymentService.initiate(orderId, userId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  // MFE-018: endpoint LEGACY — pasangan kanonisnya POST /payments/cancel
  // tidak ada; pembatalan kanonis via POST /v1/orders/{orderId}/payments
  // ulang dengan metode lain atau biarkan kedaluwarsa. DITANDAI DEPRECATED
  // (JANGAN dihapus — klien lama masih bisa memanggil).
  @Post(':orderId/pay-dana/cancel')
  @HttpCode(200)
  @ApiOperation({
    summary: '[DEPRECATED] Batalkan charge DANA-direct yang masih PENDING',
    description:
      'DEPRECATED — endpoint ini dipertahankan untuk kompatibilitas klien lama.',
    deprecated: true,
  })
  async cancelDanaDirectPayment(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ cancelled: boolean }> {
    await this.danaDirectPaymentService.cancelPending(orderId, userId);
    return { cancelled: true };
  }

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':orderId/dana-payment-status')
  @ApiOperation({ summary: 'Status pembayaran DANA-direct untuk order ini' })
  async getDanaDirectPaymentStatus(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ payment: DanaDirectPayResult | null }> {
    return { payment: await this.danaDirectPaymentService.getStatus(orderId, userId) };
  }

  /**
   * Misi tanpa-wallet (BI-safe) — KONTRAK KANONIS.
   * Daftar metode bayar DANA yang didukung untuk order ini (QRIS / VA /
   * BALANCE) — TIDAK hardcode QRIS saja.
   */
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':orderId/payment-methods')
  @ApiOperation({
    summary: 'Daftar metode bayar DANA yang didukung untuk order ini (kontrak kanonis)',
    description:
      'Kontrak kanonis mode tanpa-wallet. Frontend render daftar ini apa adanya; ' +
      'jangan hardcode QRIS saja di klien.',
  })
  async getOrderPaymentMethods(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ walletEnabled: false; methods: DanaPaymentMethodInfo[] }> {
    // Verifikasi kepesertaan order (lempar 400 bila bukan peserta / tak ada).
    await this.danaDirectPaymentService.assertOrderPayable(orderId, userId);
    return { walletEnabled: false, methods: listDanaDirectPaymentMethods() };
  }

  /**
   * Misi tanpa-wallet (BI-safe) — KONTRAK KANONIS.
   * Buat pembayaran DANA untuk order; kembalikan data checkout DANA
   * (qrString / paymentCode / webRedirectUrl + expiry).
   */
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post(':orderId/payments')
  @Idempotency()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Buat pembayaran DANA untuk order (kontrak kanonis)',
    description:
      'Kontrak kanonis mode tanpa-wallet. Idempoten per order: charge PENDING ' +
      'yang masih berlaku dikembalikan ulang (tidak ada charge ganda).',
  })
  async createOrderPayment(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: DanaDirectPayDto,
  ): Promise<DanaDirectPayResult> {
    return this.danaDirectPaymentService.initiate(orderId, userId, dto);
  }

  /**
   * MFE-004: endpoint status KANONIS untuk DANA-direct — didelegasikan ke
   * `DanaDirectPaymentService.getStatus` (kontrak `DanaDirectPayResult`:
   * payKind/paymentCode/qrString/webRedirectUrl/expiryTime). Fallback ke
   * service QRIS lama HANYA bila tidak ada baris DANA-direct (null) — untuk
   * intent QRIS lawas pra-migrasi. Tanpa fallback ini, FE tidak bisa
   * memulihkan QR/kode VA DANA setelah app restart.
   *
   * Audit 2026-10-03 (SEC-401): respons kini memuat status pembayaran
   * KANONIS `{ orderId, status, paidAt }` di top-level (satu-satunya sumber
   * kebenaran yang boleh dirender klien sebagai "berhasil" — jangan percaya
   * query params/deep link). Akses: hanya buyer/seller (selain itu 403).
   * Field `payment` dipertahankan untuk kompatibilitas klien lama.
   */
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':orderId/payment-status')
  @ApiOperation({
    summary: 'Status pembayaran kanonis untuk order (SEC-401)',
    description:
      'Audit 2026-10-03 (SEC-401): satu-satunya sumber kebenaran status ' +
      'pembayaran. Frontend WAJIB memanggil ini sebelum merender status sukses ' +
      '(jangan percaya query params). PAID hanya bila terverifikasi di server.',
  })
  async getOrderPaymentStatus(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{
    orderId: string;
    status: string;
    paidAt: Date | null;
    payment: DanaDirectPayResult | OrderQrisPaymentResult | null;
  }> {
    const { isBuyer, ...canonical } = await this.ordersService.getCanonicalPaymentStatus(orderId, userId);
    // Detail intent pembayaran (QR/kode VA) hanya untuk buyer — service
    // getStatus di bawah memang buyer-only (403 untuk non-buyer).
    let payment: DanaDirectPayResult | OrderQrisPaymentResult | null = null;
    if (isBuyer) {
      const dana = await this.danaDirectPaymentService.getStatus(orderId, userId);
      payment = dana ?? (await this.orderQrisPaymentService.getStatus(orderId, userId));
    }
    return { ...canonical, payment };
  }

  @Throttle({ default: { ttl: 60000, limit: 120 } })
  @Get(':orderId/status')
  @ApiOperation({
    summary: 'Get order status (lightweight)',
    description:
      'D1-005: status ringan untuk poll — 3 kolom, bukan bundle penuh getOrderDetail. Klien mem-poll ini tiap 15 detik dan hanya me-refresh bundle penuh bila status berubah.',
  })
  async getOrderStatus(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ orderId: string; status: string; updatedAt: Date }> {
    return this.ordersService.getOrderStatus(userId, orderId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Post(':orderId/process')
  @Idempotency()
  async processOrder(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ orderId: string; status: string }> {
    return this.ordersService.processOrder(orderId, userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Put(':orderId/shipping')
  @Idempotency()
  async updateShipping(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: UpdateShippingDto,
    ): Promise<{ orderId: string; trackingNumber: string | null; courierName: string | null }> {
    return this.ordersService.updateShipping(orderId, userId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Put(':orderId/preorder-estimate')
  @Idempotency()
  @ApiOperation({ summary: 'TX-UNIFIED-V2 (P1-3): seller ubah estimasi fulfillment PREORDER (sebelum buyer bayar)' })
  async updatePreorderEstimate(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: { preorderEstimatedDate: string },
  ): Promise<{ orderId: string; preorderEstimatedDate: Date | null }> {
    return this.ordersService.updatePreorderEstimate(orderId, userId, dto);
  }
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post(':orderId/complete')
  @Idempotency()
  async completeOrder(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: ConfirmReceiptDto,
    @Req() req: Request,
  ): Promise<CompleteOrderResult> {
    return this.orderStateService.handleCompleteOrder(orderId, userId, extractLocationContext(req, dto));
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post(':orderId/cancel')
  @Idempotency()
  @HttpCode(200)
  async cancelOrder(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: CancelOrderDto,
    @Req() req: Request,
  ): Promise<CancelOrderResult> {
    return this.orderStateService.handleCancelOrder(orderId, userId, dto.reason, dto.note, extractLocationContext(req, dto));
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post(':orderId/extensions')
  @Idempotency()
  async requestExtension(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: RequestExtensionDto,
  ): Promise<{ extensionId: string; requestedDays: number; status: string }> {
    return this.orderExtensionsService.requestExtension(orderId, userId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Put(':orderId/extensions/:extensionId')
  @Idempotency()
  async respondExtension(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Param('extensionId', ParseIdPipe) extensionId: string,
    @Body() dto: RespondExtensionDto,
  ): Promise<{ extensionId: string; status: string }> {
    return this.orderExtensionsService.respondExtension(extensionId, userId, dto, orderId);
  }

  @Get(':orderId/extensions/fingerprint')
  @ApiOperation({
    summary: 'Get extension requests fingerprint (lightweight)',
    description:
      'D1-010: fingerprint ringan untuk poll — total + max(updatedAt). Klien me-refresh bundle penuh hanya bila fingerprint berubah.',
  })
  async getExtensionsFingerprint(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ total: number; latestUpdatedAt: Date | null }> {
    return this.orderExtensionsService.getExtensionsFingerprint(orderId, userId);
  }

  @Get(':orderId/extensions')
  async getExtensions(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<{ data: object[]; total: number; page: number; limit: number; totalPages: number }> {
    return this.orderExtensionsService.getExtensions(orderId, userId, page, limit);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 3 } })
  @Post(':orderId/dispute')
  @Idempotency()
  async submitDispute(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: SubmitDisputeDto,
    @Req() req: Request,
  ): Promise<object> {
    return this.disputesService.submitDispute(orderId, userId, dto, extractLocationContext(req, dto));
  }

  @Get(':orderId/history')
  async getOrderHistory(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<{ data: object[]; total: number; page: number; limit: number; totalPages: number }> {
    return this.ordersService.getOrderHistory(orderId, userId, page, limit);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 20 } })
  @Post('links')
  @Idempotency()
  @HttpCode(201)
  @ApiOperation({ summary: 'Create an order link (Order via Link)' })
  async createOrderLink(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateOrderLinkDto,
  ): Promise<object> {
    return this.orderLinksService.createLink(userId, dto);
  }

  @Get('links/my')
  @ApiOperation({ summary: 'Get my order links' })
  async getMyOrderLinks(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.orderLinksService.getMyLinks(userId, page, limit);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get('links/:token')
  @ApiOperation({ summary: 'Get order link details by token' })
  async getOrderLinkByToken(@Param('token', ParseTokenPipe) token: string): Promise<object> {
    return this.orderLinksService.getLinkByToken(token);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @Post('links/:token/accept')
  @Idempotency()
  @ApiOperation({ summary: 'Accept an order link' })
  async acceptOrderLink(
    @CurrentUser('sub') userId: string,
    @Param('token', ParseTokenPipe) token: string,
    @Body() dto: AcceptOrderLinkDto,
  ): Promise<object> {
    return this.orderLinksService.acceptLink(token, userId, dto);
  }

  /*
   * C-26: mirrors `createOrderLink` (:305). A creator cannot cancel more links than they created,
   * so the create-side ceiling is the tightest bound that cannot reject a legitimate call.
   */
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 20 } })
  @Post('links/:token/cancel')
  @Idempotency()
  @ApiOperation({ summary: 'Cancel an order link' })
  async cancelOrderLink(
    @CurrentUser('sub') userId: string,
    @Param('token', ParseTokenPipe) token: string,
  ): Promise<{ message: string }> {
    return this.orderLinksService.cancelLink(token, userId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 3600000, limit: 10 } })
  @Post(':orderId/delivery-proof')
  @Idempotency()
  @ApiOperation({ summary: 'Submit delivery proof' })
  async submitDeliveryProof(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: SubmitDeliveryProofDto,
  ): Promise<object> {
    return this.deliveryProofService.submitProof(orderId, userId, dto);
  }

  @Get(':orderId/delivery-proof/fingerprint')
  @ApiOperation({
    summary: 'Get delivery proof fingerprint (lightweight)',
    description:
      'D1-010: fingerprint ringan untuk poll — count + max(updatedAt). Klien me-refresh bundle penuh hanya bila fingerprint berubah.',
  })
  async getDeliveryProofFingerprint(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ count: number; latestUpdatedAt: Date | null }> {
    return this.deliveryProofService.getProofsFingerprint(orderId, userId);
  }

  @Get(':orderId/delivery-proof')
  @ApiOperation({ summary: 'Get delivery proofs for an order' })
  async getDeliveryProofs(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<object[]> {
    return this.deliveryProofService.getProofs(orderId, userId);
  }

  /*
   * C-26: exact mirror of `POST :orderId/complete` (:227).
   *
   * Both routes end in `OrderStateService.handleCompleteOrder` — the escrow release. `complete` was
   * capped at 5 per 15 min with a per-user window on top; this one carried neither decorator, so it
   * fell through to the 100/min `ThrottlerGuard` default and was a 20x-looser alternate route to the
   * same money movement, per-IP only. The limits are copied rather than chosen so the two entry
   * points to one operation cannot drift apart again.
   */
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post(':orderId/delivery-proof/confirm')
  @Idempotency()
  @ApiOperation({ summary: 'Confirm delivery (buyer)' })
  async confirmDelivery(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: ConfirmDeliveryDto,
  ): Promise<{ message: string }> {
    return this.deliveryProofService.confirmDelivery(orderId, userId, dto.proofId);
  }

  /*
   * C-26: mirrors `respondExtension` (:262) — the other "buyer responds to a seller submission"
   * route. Rejection is repeatable where confirmation is terminal, so it keeps the looser limit of
   * the two; `MAX_REJECTION_COUNT = 5` (`delivery-proof.service.ts:229`) bounds how many rejections
   * can matter per order regardless.
   */
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Post(':orderId/delivery-proof/reject')
  @Idempotency()
  @ApiOperation({ summary: 'Reject delivery proof (buyer)' })
  async rejectDelivery(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: RejectDeliveryDto,
  ): Promise<{ message: string }> {
    return this.deliveryProofService.rejectDelivery(orderId, userId, dto.note, dto.proofId);
  }

  @Get(':orderId/invoice')
  @ApiOperation({ summary: 'Get invoice data for an order' })
  async getInvoice(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<object> {
    return this.invoiceService.getInvoiceData(orderId, userId);
  }

  @Get(':orderId/invoice/pdf')
  @ApiOperation({ summary: 'Get invoice PDF (20.2)' })
  async getInvoicePdf(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ pdfBase64: string; filename: string }> {
    const buffer = await this.invoiceService.generateInvoicePdf(orderId, userId);
    return { pdfBase64: buffer.toString('base64'), filename: `invoice-${orderId}.pdf` };
  }

  @Get(':orderId/receipt')
  @ApiOperation({ summary: 'Get printable receipt HTML for completed order' })
  async getReceipt(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ html: string }> {
    const html = await this.receiptService.generateReceiptHtml(orderId, userId);
    return { html };
  }
}
