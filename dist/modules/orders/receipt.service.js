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
exports.ReceiptService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const ErrorCodes = __importStar(require("../../common/constants/error-codes"));
const currency_util_1 = require("../../common/utils/currency.util");
function escapeHtml(str) {
    if (!str)
        return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
let ReceiptService = class ReceiptService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    async generateReceiptHtml(orderId, userId) {
        const order = await this.prisma.order.findFirst({
            where: { orderId },
            include: {
                buyer: { select: { userId: true, fullName: true, username: true } },
                seller: { select: { userId: true, fullName: true, username: true } },
                voucher: { select: { code: true, name: true } },
                statusHistories: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
            },
        });
        if (!order)
            throw new common_1.NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order not found' });
        if (order.buyerId !== userId && order.sellerId !== userId) {
            throw new common_1.ForbiddenException({ code: ErrorCodes.NOT_ORDER_PARTICIPANT, message: 'Not a participant' });
        }
        if (!['COMPLETED', 'DISPUTED'].includes(order.status)) {
            throw new common_1.BadRequestException({ code: 'RECEIPT_NOT_AVAILABLE', message: 'Receipt only available for completed or disputed orders' });
        }
        const formatCurrency = (amount) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
        const statusLabel = {
            WAITING_CONFIRMATION: 'Waiting for Confirmation',
            WAITING_PAYMENT: 'Waiting for Payment',
            PROCESSING: 'Processing',
            IN_DELIVERY: 'In Delivery',
            COMPLETED: 'Completed',
            DISPUTED: 'Disputed',
            CANCELLED: 'Cancelled',
        };
        const timeline = order.statusHistories.map((h) => ({
            status: statusLabel[h.toStatus] || h.toStatus,
            date: h.createdAt.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
        }));
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transaction Receipt - ${order.orderId}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#1a1a2e;background:#f8f9fa;padding:20px}
.receipt{max-width:600px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);overflow:hidden}
.header{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:32px;text-align:center}
.header h1{font-size:20px;margin-bottom:4px}
.header .id{font-size:13px;opacity:.85}
.header .status{display:inline-block;background:rgba(255,255,255,.2);padding:4px 16px;border-radius:20px;margin-top:12px;font-size:13px;font-weight:600}
.body{padding:24px 32px}
.section{margin-bottom:24px}
.section-title{font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:12px;font-weight:600}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f3f4f6}
.row:last-child{border-bottom:none}
.row .label{color:#6b7280;font-size:14px}
.row .value{font-weight:500;font-size:14px;text-align:right}
.total-row{background:#f8f9fa;padding:12px 16px;border-radius:8px;margin-top:8px}
.total-row .value{color:#6366f1;font-weight:700;font-size:16px}
.party{display:flex;align-items:center;gap:12px;padding:8px 0}
.party-label{font-size:12px;color:#6b7280;text-transform:uppercase}
.party-name{font-weight:600;font-size:14px}
.party-detail{font-size:12px;color:#6b7280}
.timeline{position:relative;padding-left:20px}
.timeline-item{position:relative;padding-bottom:16px;padding-left:16px;border-left:2px solid #e5e7eb}
.timeline-item:last-child{border-left-color:transparent}
.timeline-item::before{content:'';position:absolute;left:-6px;top:4px;width:10px;height:10px;border-radius:50%;background:#6366f1}
.timeline-item .time{font-size:12px;color:#6b7280}
.timeline-item .event{font-size:13px;font-weight:500;margin-top:2px}
.footer{text-align:center;padding:24px 32px;border-top:1px solid #f3f4f6;color:#9ca3af;font-size:12px}
.footer p{margin-bottom:4px}
@media print{body{background:#fff;padding:0}.receipt{box-shadow:none;border-radius:0}}
</style>
</head>
<body>
<div class="receipt">
<div class="header">
<h1>Transaction Receipt</h1>
<div class="id">${order.orderId}</div>
<div class="status">${statusLabel[order.status] || order.status}</div>
</div>
<div class="body">
<div class="section">
<div class="section-title">Transaction Details</div>
<div class="row"><span class="label">Title</span><span class="value">${escapeHtml(order.title)}</span></div>
<div class="row"><span class="label">Type</span><span class="value">${order.orderType.replace('_', ' ')}</span></div>
<div class="row"><span class="label">Date</span><span class="value">${order.createdAt.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>
${order.completedAt ? `<div class="row"><span class="label">Completed</span><span class="value">${order.completedAt.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}</span></div>` : ''}
</div>
<div class="section">
<div class="section-title">Parties Involved</div>
<div class="party"><div><div class="party-label">Buyer</div><div class="party-name">${escapeHtml(order.buyer.fullName)}</div><div class="party-detail">@${escapeHtml(order.buyer.username || order.buyer.userId)}</div></div></div>
<div class="party"><div><div class="party-label">Seller</div><div class="party-name">${escapeHtml(order.seller.fullName)}</div><div class="party-detail">@${escapeHtml(order.seller.username || order.seller.userId)}</div></div></div>
</div>
<div class="section">
<div class="section-title">Payment Details</div>
<div class="row"><span class="label">Order Value</span><span class="value">${formatCurrency((0, currency_util_1.toIdr)(order.orderValue))}</span></div>
<div class="row"><span class="label">Platform Fee (${Number(order.feeRate).toFixed(1)}%)</span><span class="value">${formatCurrency((0, currency_util_1.toIdr)(order.feeAmount))}</span></div>
<div class="row"><span class="label">Buyer Fee</span><span class="value">${formatCurrency((0, currency_util_1.toIdr)(order.buyerFeeAmount))}</span></div>
<div class="row"><span class="label">Seller Fee</span><span class="value">${formatCurrency((0, currency_util_1.toIdr)(order.sellerFeeAmount))}</span></div>
${order.voucherDiscount > BigInt(0) ? `<div class="row"><span class="label">Voucher Discount (${escapeHtml(order.voucher?.code)})</span><span class="value" style="color:#10b981">-${formatCurrency((0, currency_util_1.toIdr)(order.voucherDiscount))}</span></div>` : ''}
<div class="row total-row"><span class="label"><strong>Total Buyer Pays</strong></span><span class="value">${formatCurrency((0, currency_util_1.toIdr)(order.buyerPayAmount))}</span></div>
<div class="row total-row"><span class="label"><strong>Total Seller Receives</strong></span><span class="value">${formatCurrency((0, currency_util_1.toIdr)(order.sellerReceiveAmount))}</span></div>
</div>
${order.trackingNumber ? `<div class="section"><div class="section-title">Shipping</div><div class="row"><span class="label">Courier</span><span class="value">${escapeHtml(order.courierName) || '-'}</span></div><div class="row"><span class="label">Tracking No.</span><span class="value">${escapeHtml(order.trackingNumber)}</span></div></div>` : ''}
<div class="section">
<div class="section-title">Timeline</div>
<div class="timeline">
${timeline.map((t) => `<div class="timeline-item"><div class="time">${t.date}</div><div class="event">${t.status}</div></div>`).join('\n')}
</div>
</div>
</div>
<div class="footer">
<p><strong>Kahade — P2P Escrow Platform</strong></p>
<p>PT Kawal Hak Dengan Aman</p>
<p>This document is automatically generated and valid without a signature.</p>
<p>Printed: ${new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
</div>
</div>
</body>
</html>`;
    }
};
exports.ReceiptService = ReceiptService;
exports.ReceiptService = ReceiptService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ReceiptService);
