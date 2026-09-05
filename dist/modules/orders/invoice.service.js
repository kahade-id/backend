"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InvoiceService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const currency_util_1 = require("../../common/utils/currency.util");
let InvoiceService = class InvoiceService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getInvoiceData(orderId, userId) {
        const order = await this.prisma.order.findFirst({
            where: { orderId },
            include: {
                buyer: { select: { userId: true, fullName: true, username: true } },
                seller: { select: { userId: true, fullName: true, username: true } },
                voucher: { select: { code: true, name: true } },
            },
        });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.buyerId !== userId && order.sellerId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not a participant' });
        }
        if (order.status === 'WAITING_CONFIRMATION' || order.status === 'CANCELLED') {
            throw new common_1.ForbiddenException({ code: ErrorCodes.INVALID_ORDER_STATUS, message: 'Invoice not available for this status' });
        }
        return {
            invoiceNumber: `INV-${order.orderId}`,
            orderId: order.orderId,
            orderDate: order.createdAt,
            paidAt: order.paidAt,
            completedAt: order.completedAt,
            status: order.status,
            buyer: {
                userId: order.buyer.userId,
                fullName: order.buyer.fullName,
                username: order.buyer.username,
            },
            seller: {
                userId: order.seller.userId,
                fullName: order.seller.fullName,
                username: order.seller.username,
            },
            items: {
                title: order.title,
                description: order.description,
                orderType: order.orderType,
                orderValue: (0, currency_util_1.toIdr)(order.orderValue),
            },
            fees: {
                feeRate: Number(order.feeRate),
                feeAmount: (0, currency_util_1.toIdr)(order.feeAmount),
                feeResponsibility: order.feeResponsibility,
                buyerFeeAmount: (0, currency_util_1.toIdr)(order.buyerFeeAmount),
                sellerFeeAmount: (0, currency_util_1.toIdr)(order.sellerFeeAmount),
                voucherDiscount: (0, currency_util_1.toIdr)(order.voucherDiscount),
                voucherCode: order.voucher?.code || null,
            },
            totals: {
                buyerPayAmount: (0, currency_util_1.toIdr)(order.buyerPayAmount),
                sellerReceiveAmount: (0, currency_util_1.toIdr)(order.sellerReceiveAmount),
            },
            company: {
                name: 'PT Kahade Digital Indonesia',
                address: 'Jakarta, Indonesia',
            },
        };
    }
};
exports.InvoiceService = InvoiceService;
exports.InvoiceService = InvoiceService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], InvoiceService);
