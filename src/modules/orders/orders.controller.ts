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
import { DisputesService } from '../disputes/disputes.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateOrderLinkDto } from './dto/create-order-link.dto';
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
} from './dto/order-actions.dto';
import { ConfirmDeliveryDto, SubmitDeliveryProofDto, RejectDeliveryDto } from './dto/delivery-proof.dto';

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
    feeRate: number;
    feeAmount: number;
    buyerFeeAmount: number;
    sellerFeeAmount: number;
    buyerPayAmount: number;
    sellerReceiveAmount: number;
    voucherDiscount: number;
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
    };
    confirmationDeadlineAt: Date | null;
  }> {
    return this.ordersService.createOrder(userId, dto);
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
      orderValue: number;
      buyerPayAmount: number;
      sellerReceiveAmount: number;
      buyer: { userId: string; username: string | null; fullName: string | null; avatarUrl: string | null };
      seller: { userId: string; username: string | null; fullName: string | null; avatarUrl: string | null };
      role: 'BUYER' | 'SELLER';
      createdAt: Date;
    }[];
    total: number;
    page: number;
    limit: number;
  }> {
    return this.ordersService.getOrders(userId, query.page, query.limit, query.status as OrderStatus | undefined, query.role, query.search);
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

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post(':orderId/pay')
  @Idempotency()
  async payOrder(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
    @Body() dto: PayOrderDto,
    @Req() req: Request,
  ): Promise<PayOrderResult> {
    return this.orderStateService.handlePayOrder(orderId, userId, dto.pin, req.ip);
  }

  @UseGuards(UserThrottleGuard)
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

  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':orderId/payment-status')
  async getOrderPaymentStatus(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<{ payment: OrderQrisPaymentResult | null }> {
    return { payment: await this.orderQrisPaymentService.getStatus(orderId, userId) };
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
  @Throttle({ default: { ttl: 900000, limit: 5 } })
  @Post(':orderId/complete')
  @Idempotency()
  async completeOrder(
    @CurrentUser('sub') userId: string,
    @Param('orderId', ParseIdPipe) orderId: string,
  ): Promise<CompleteOrderResult> {
    return this.orderStateService.handleCompleteOrder(orderId, userId);
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
  ): Promise<CancelOrderResult> {
    return this.orderStateService.handleCancelOrder(orderId, userId, dto.reason, dto.note);
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
  ): Promise<object> {
    return this.disputesService.submitDispute(orderId, userId, dto);
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
  ): Promise<object> {
    return this.orderLinksService.acceptLink(token, userId);
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
