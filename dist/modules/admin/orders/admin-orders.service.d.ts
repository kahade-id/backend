import { PrismaService } from '../../../prisma/prisma.service';
import { OrderStatus } from '@prisma/client';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { AuditLogService } from '../../../common/services/audit-log.service';
import { WalletTxSerialService } from '../../../common/services/wallet-tx-serial.service';
import { OrderStateService } from '../../orders/order-state.service';
import { FeeCalculatorService } from '../../orders/fee-calculator.service';
import { ReferralService } from '../../referral/referral.service';
import { MembershipRankService } from '../../orders/membership-rank.service';
import { AdminOrderQueryDto, ForceActionDto } from './dto/admin-order-query.dto';
export declare class AdminOrdersService {
    private prisma;
    private auditLog;
    private orderStateService;
    private feeCalculator;
    private walletTxSerialService;
    private referralService;
    private membershipRankService;
    private readonly logger;
    constructor(prisma: PrismaService, auditLog: AuditLogService, orderStateService: OrderStateService, feeCalculator: FeeCalculatorService, walletTxSerialService: WalletTxSerialService, referralService: ReferralService, membershipRankService: MembershipRankService);
    private withSerializableRetry;
    listOrders(query: AdminOrderQueryDto): Promise<PaginatedResponse<Record<string, unknown>>>;
    getOrderDetail(orderId: string): Promise<Record<string, unknown>>;
    forceCancel(orderId: string, adminId: string, dto: ForceActionDto, ipAddress?: string): Promise<{
        orderId: string;
        status: OrderStatus;
    }>;
    forceComplete(orderId: string, adminId: string, dto: ForceActionDto, ipAddress?: string): Promise<{
        orderId: string;
        status: OrderStatus;
    }>;
}
