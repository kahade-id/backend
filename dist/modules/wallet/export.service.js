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
exports.WalletExportService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const ExcelJS = __importStar(require("exceljs"));
const currency_util_1 = require("../../common/utils/currency.util");
const date_util_1 = require("../../common/utils/date.util");
function escapeHtml(str) {
    if (!str)
        return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function sanitizeCell(val) {
    if (/^[=+\-@\t\r]/.test(val))
        return `'${val}`;
    return val;
}
const TYPE_LABELS = {
    TOP_UP: 'Top Up',
    WITHDRAW: 'Withdrawal',
    ORDER_LOCK: 'Escrow Lock',
    ORDER_RELEASE: 'Escrow Release',
    ORDER_REFUND: 'Refund',
    FEE_DEDUCT: 'Platform Fee',
    REFERRAL_REWARD: 'Referral Bonus',
    SUBSCRIPTION_PAYMENT: 'Subscription',
    ADMIN_CREDIT: 'Admin Credit',
    ADMIN_DEBIT: 'Admin Debit',
    DISPUTE_RELEASE: 'Dispute Release',
    TRANSFER_SENT: 'Transfer Sent',
    TRANSFER_RECEIVED: 'Transfer Received',
};
const STATUS_LABELS = {
    PENDING: 'Pending',
    SUCCESS: 'Success',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled',
    REVERSED: 'Reversed',
};
const CURSOR_BATCH_SIZE = 500;
let WalletExportService = class WalletExportService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    buildWhere(walletId, filters) {
        const where = { walletId };
        if (filters.startDate || filters.endDate) {
            where.createdAt = {};
            if (filters.startDate)
                where.createdAt.gte = (0, date_util_1.parseDateBoundaryWIB)(filters.startDate, 'start');
            if (filters.endDate)
                where.createdAt.lte = (0, date_util_1.parseDateBoundaryWIB)(filters.endDate, 'end');
        }
        if (filters.types && filters.types.length > 0) {
            where.type = { in: filters.types };
        }
        return where;
    }
    async *fetchTransactionsCursor(walletId, filters) {
        const where = this.buildWhere(walletId, filters);
        let cursor;
        while (true) {
            const batch = await this.prisma.walletTransaction.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: CURSOR_BATCH_SIZE,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                include: {
                    order: { select: { orderId: true, title: true } },
                },
            });
            if (batch.length === 0)
                break;
            for (const tx of batch) {
                yield tx;
            }
            if (batch.length < CURSOR_BATCH_SIZE)
                break;
            cursor = batch[batch.length - 1].id;
        }
    }
    formatCsvRow(tx) {
        const date = tx.createdAt.toISOString().replace('T', ' ').substring(0, 19);
        const amount = (0, currency_util_1.toIdr)(tx.amount);
        const balanceAfter = (0, currency_util_1.toIdr)(tx.balanceAfter);
        const type = TYPE_LABELS[tx.type] || tx.type;
        const status = STATUS_LABELS[tx.status] || tx.status;
        const orderId = tx.order?.orderId || '';
        const rawDesc = (tx.description || tx.order?.title || '').replace(/,/g, ';').replace(/"/g, "'");
        const desc = sanitizeCell(rawDesc);
        return [
            date, tx.id, sanitizeCell(type), `"${desc}"`,
            amount.toString(), balanceAfter.toString(), status, sanitizeCell(orderId),
        ].join(',');
    }
    async streamTransactionsCsv(userId, output, startDate, endDate, types) {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            return false;
        const header = ['Date', 'Transaction ID', 'Type', 'Description', 'Amount (IDR)', 'Balance After (IDR)', 'Status', 'Order ID'].join(',');
        output.write(header + '\n');
        for await (const tx of this.fetchTransactionsCursor(wallet.id, { startDate, endDate, types })) {
            const canContinue = output.write(this.formatCsvRow(tx) + '\n');
            if (!canContinue) {
                await new Promise((resolve) => output.once('drain', resolve));
            }
        }
        return true;
    }
    async exportTransactionsCsv(userId, startDate, endDate, types) {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            return '';
        const header = ['Date', 'Transaction ID', 'Type', 'Description', 'Amount (IDR)', 'Balance After (IDR)', 'Status', 'Order ID'].join(',');
        const rows = [header];
        for await (const tx of this.fetchTransactionsCursor(wallet.id, { startDate, endDate, types })) {
            rows.push(this.formatCsvRow(tx));
        }
        return rows.join('\n');
    }
    async exportTransactionsXlsx(userId, startDate, endDate, types) {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        const workbook = new ExcelJS.Workbook();
        workbook.creator = 'Kahade';
        workbook.created = new Date();
        const sheet = workbook.addWorksheet('Transactions');
        sheet.columns = [
            { header: 'Date', key: 'date', width: 22 },
            { header: 'Transaction ID', key: 'txId', width: 28 },
            { header: 'Type', key: 'type', width: 18 },
            { header: 'Description', key: 'description', width: 35 },
            { header: 'Amount (IDR)', key: 'amount', width: 18 },
            { header: 'Balance After (IDR)', key: 'balanceAfter', width: 20 },
            { header: 'Status', key: 'status', width: 14 },
            { header: 'Order ID', key: 'orderId', width: 20 },
        ];
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6366F1' } };
        headerRow.alignment = { horizontal: 'center' };
        if (wallet) {
            for await (const tx of this.fetchTransactionsCursor(wallet.id, { startDate, endDate, types })) {
                const amount = (0, currency_util_1.toIdr)(tx.amount);
                const balanceAfter = (0, currency_util_1.toIdr)(tx.balanceAfter);
                sheet.addRow({
                    date: tx.createdAt.toISOString().replace('T', ' ').substring(0, 19),
                    txId: sanitizeCell(tx.id),
                    type: sanitizeCell(TYPE_LABELS[tx.type] || tx.type),
                    description: sanitizeCell(tx.description || tx.order?.title || ''),
                    amount,
                    balanceAfter,
                    status: sanitizeCell(STATUS_LABELS[tx.status] || tx.status),
                    orderId: sanitizeCell(tx.order?.orderId || ''),
                });
            }
        }
        sheet.getColumn('amount').numFmt = '#,##0';
        sheet.getColumn('balanceAfter').numFmt = '#,##0';
        const buffer = await workbook.xlsx.writeBuffer();
        return Buffer.from(buffer);
    }
    async exportTransactionsHtml(userId, startDate, endDate) {
        const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
        if (!wallet)
            return '';
        const transactions = [];
        for await (const tx of this.fetchTransactionsCursor(wallet.id, { startDate, endDate })) {
            transactions.push(tx);
        }
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: { fullName: true, userId: true, email: true },
        });
        const formatCurrency = (amount) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(amount);
        const INCOME_TYPES = ['TOP_UP', 'ORDER_RELEASE', 'ORDER_REFUND', 'REFERRAL_REWARD', 'ADMIN_CREDIT', 'DISPUTE_RELEASE', 'TRANSFER_RECEIVED'];
        const EXPENSE_TYPES = ['WITHDRAW', 'ORDER_LOCK', 'FEE_DEDUCT', 'SUBSCRIPTION_PAYMENT', 'ADMIN_DEBIT', 'TRANSFER_SENT'];
        const totalIn = transactions.filter((t) => INCOME_TYPES.includes(t.type) && t.status === 'SUCCESS')
            .reduce((s, t) => s + (0, currency_util_1.toIdr)(t.amount), 0);
        const totalOut = transactions.filter((t) => EXPENSE_TYPES.includes(t.type) && t.status === 'SUCCESS')
            .reduce((s, t) => s + (0, currency_util_1.toIdr)(t.amount), 0);
        const rows = transactions.map((tx) => {
            const isIncome = INCOME_TYPES.includes(tx.type);
            return `<tr>
<td>${(0, date_util_1.formatWIBDate)(tx.createdAt)}</td>
<td>${escapeHtml(TYPE_LABELS[tx.type] || tx.type)}</td>
<td style="color:${isIncome ? '#10b981' : '#ef4444'};font-weight:600">${isIncome ? '+' : '-'}${formatCurrency((0, currency_util_1.toIdr)(tx.amount))}</td>
<td>${escapeHtml(tx.order?.orderId) || '-'}</td>
<td>${escapeHtml(tx.description || tx.order?.title) || '-'}</td>
</tr>`;
        }).join('\n');
        const periodStr = startDate && endDate
            ? `${(0, date_util_1.formatWIBDate)(new Date(startDate))} - ${(0, date_util_1.formatWIBDate)(new Date(endDate))}`
            : 'All Time';
        return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Financial Report - ${user?.fullName || ''}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Segoe UI',sans-serif;color:#1a1a2e;background:#fff;padding:20px}
.report{max-width:800px;margin:0 auto}
.header{text-align:center;padding:24px 0;border-bottom:2px solid #6366f1;margin-bottom:24px}
.header h1{font-size:18px;color:#6366f1}
.header p{font-size:13px;color:#6b7280;margin-top:4px}
.summary{display:flex;gap:16px;margin-bottom:24px}
.summary-card{flex:1;padding:16px;border-radius:8px;text-align:center}
.summary-card.in{background:#ecfdf5;color:#10b981}
.summary-card.out{background:#fef2f2;color:#ef4444}
.summary-card.net{background:#f0f0ff;color:#6366f1}
.summary-card .label{font-size:12px;text-transform:uppercase}
.summary-card .amount{font-size:18px;font-weight:700;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{background:#f8f9fa;padding:10px 8px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#6b7280;border-bottom:2px solid #e5e7eb}
td{padding:8px;border-bottom:1px solid #f3f4f6}
.footer{text-align:center;padding:24px 0;margin-top:24px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:11px}
@media print{body{padding:0}}
</style></head><body>
<div class="report">
<div class="header">
<h1>Kahade Financial Report</h1>
<p>${escapeHtml(user?.fullName)} (${escapeHtml(user?.userId)}) — Period: ${periodStr}</p>
</div>
<div class="summary">
<div class="summary-card in"><div class="label">Total In</div><div class="amount">${formatCurrency(totalIn)}</div></div>
<div class="summary-card out"><div class="label">Total Out</div><div class="amount">${formatCurrency(totalOut)}</div></div>
<div class="summary-card net"><div class="label">Net</div><div class="amount">${formatCurrency(totalIn - totalOut)}</div></div>
</div>
<table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Order</th><th>Description</th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="footer"><p>Kahade — PT Kawal Hak Dengan Aman</p><p>Printed: ${new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
</div></body></html>`;
    }
};
exports.WalletExportService = WalletExportService;
exports.WalletExportService = WalletExportService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], WalletExportService);
