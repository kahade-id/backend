import { Request } from 'express';
import { OrdersService } from './orders.service';
import { OrderStateService, ConfirmOrderResult, PayOrderResult, CompleteOrderResult, CancelOrderResult } from './order-state.service';
import { OrderExtensionsService } from './order-extensions.service';
import { OrderLinksService } from './order-links.service';
import { DeliveryProofService } from './delivery-proof.service';
import { InvoiceService } from './invoice.service';
import { ReceiptService } from './receipt.service';
import { OrderQrisPaymentService, OrderQrisPaymentResult } from '../payment/order-qris-payment.service';
import { DisputesService } from '../disputes/disputes.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateOrderLinkDto } from './dto/create-order-link.dto';
import { GetOrdersQueryDto } from './dto/get-orders-query.dto';
import { CalculateFeeDto, ConfirmOrderDto, UpdateShippingDto, RequestExtensionDto, RespondExtensionDto, CancelOrderDto, SubmitDisputeDto, ValidateCounterpartDto, PayOrderDto } from './dto/order-actions.dto';
import { ConfirmDeliveryDto, SubmitDeliveryProofDto, RejectDeliveryDto } from './dto/delivery-proof.dto';
export declare class OrdersController {
    private ordersService;
    private orderStateService;
    private orderExtensionsService;
    private orderLinksService;
    private deliveryProofService;
    private invoiceService;
    private receiptService;
    private orderQrisPaymentService;
    private disputesService;
    constructor(ordersService: OrdersService, orderStateService: OrderStateService, orderExtensionsService: OrderExtensionsService, orderLinksService: OrderLinksService, deliveryProofService: DeliveryProofService, invoiceService: InvoiceService, receiptService: ReceiptService, orderQrisPaymentService: OrderQrisPaymentService, disputesService: DisputesService);
    getOrderSummary(userId: string): Promise<{
        asBuyer: {
            count: number;
            totalValue: number;
        };
        asSeller: {
            count: number;
            totalValue: number;
        };
        inDispute: number;
        pendingExtensions: number;
    }>;
    getAverageDurations(): Promise<Record<string, number>>;
    calculateFee(userId: string, dto: CalculateFeeDto): Promise<{
        feeRate: number;
        feeAmount: number;
        buyerFeeAmount: number;
        sellerFeeAmount: number;
        buyerPayAmount: number;
        sellerReceiveAmount: number;
        voucherDiscount: number;
        isKahadePlusApplied: boolean;
    }>;
    validateCounterpart(userId: string, dto: ValidateCounterpartDto): Promise<{
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
    }>;
    createOrder(userId: string, dto: CreateOrderDto): Promise<{
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
    }>;
    getOrders(userId: string, query: GetOrdersQueryDto): Promise<{
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
            buyer: {
                userId: string;
                username: string | null;
                fullName: string | null;
                avatarUrl: string | null;
            };
            seller: {
                userId: string;
                username: string | null;
                fullName: string | null;
                avatarUrl: string | null;
            };
            role: 'BUYER' | 'SELLER';
            createdAt: Date;
        }[];
        total: number;
        page: number;
        limit: number;
    }>;
    getOrderDetail(userId: string, orderId: string): Promise<{
        order: object;
    }>;
    confirmOrder(userId: string, orderId: string, dto: ConfirmOrderDto): Promise<ConfirmOrderResult>;
    payOrder(userId: string, orderId: string, dto: PayOrderDto, req: Request): Promise<PayOrderResult>;
    initiateQrisOrderPayment(userId: string, orderId: string): Promise<OrderQrisPaymentResult>;
    getOrderPaymentStatus(userId: string, orderId: string): Promise<{
        payment: OrderQrisPaymentResult | null;
    }>;
    processOrder(userId: string, orderId: string): Promise<{
        orderId: string;
        status: string;
    }>;
    updateShipping(userId: string, orderId: string, dto: UpdateShippingDto): Promise<{
        orderId: string;
        trackingNumber: string | null;
        courierName: string | null;
    }>;
    completeOrder(userId: string, orderId: string): Promise<CompleteOrderResult>;
    cancelOrder(userId: string, orderId: string, dto: CancelOrderDto): Promise<CancelOrderResult>;
    requestExtension(userId: string, orderId: string, dto: RequestExtensionDto): Promise<{
        extensionId: string;
        requestedDays: number;
        status: string;
    }>;
    respondExtension(userId: string, orderId: string, extensionId: string, dto: RespondExtensionDto): Promise<{
        extensionId: string;
        status: string;
    }>;
    getExtensions(userId: string, orderId: string, page: number, limit: number): Promise<{
        data: object[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    }>;
    submitDispute(userId: string, orderId: string, dto: SubmitDisputeDto): Promise<object>;
    getOrderHistory(userId: string, orderId: string, page: number, limit: number): Promise<{
        data: object[];
        total: number;
        page: number;
        limit: number;
        totalPages: number;
    }>;
    createOrderLink(userId: string, dto: CreateOrderLinkDto): Promise<object>;
    getMyOrderLinks(userId: string, page: number, limit: number): Promise<object>;
    getOrderLinkByToken(token: string): Promise<object>;
    acceptOrderLink(userId: string, token: string): Promise<object>;
    cancelOrderLink(userId: string, token: string): Promise<{
        message: string;
    }>;
    submitDeliveryProof(userId: string, orderId: string, dto: SubmitDeliveryProofDto): Promise<object>;
    getDeliveryProofs(userId: string, orderId: string): Promise<object[]>;
    confirmDelivery(userId: string, orderId: string, dto: ConfirmDeliveryDto): Promise<{
        message: string;
    }>;
    rejectDelivery(userId: string, orderId: string, dto: RejectDeliveryDto): Promise<{
        message: string;
    }>;
    getInvoice(userId: string, orderId: string): Promise<object>;
    getReceipt(userId: string, orderId: string): Promise<{
        html: string;
    }>;
}
