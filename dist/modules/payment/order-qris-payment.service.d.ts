import { ConfigService } from '@nestjs/config';
import { PaymentStatus } from '@prisma/client';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MidtransService } from './midtrans.service';
export interface OrderQrisPaymentResult {
    paymentTxId: string;
    orderId: string;
    status: PaymentStatus;
    escrowAmount: number;
    providerFee: number;
    grossAmount: number;
    qrString: string | null;
    qrCodeUrl: string | null;
    expiryTime: Date;
}
export declare class OrderQrisPaymentService {
    private readonly prisma;
    private readonly midtrans;
    private readonly config;
    private readonly walletTxSerialService;
    private readonly logger;
    constructor(prisma: PrismaService, midtrans: MidtransService, config: ConfigService, walletTxSerialService: WalletTxSerialService);
    private qrisFee;
    private expiryAt;
    private parseGrossAmountToSen;
    private serializePayment;
    initiate(orderId: string, buyerId: string): Promise<OrderQrisPaymentResult>;
    getStatus(orderId: string, buyerId: string): Promise<OrderQrisPaymentResult | null>;
    handleSettlement(midtransOrderId: string, grossAmount: string): Promise<void>;
    handleFailure(midtransOrderId: string, providerStatus: string): Promise<void>;
    requestRefund(midtransOrderId: string, reason: string): Promise<void>;
    requestRefundForOrder(orderId: string, reason: string): Promise<void>;
    cancelPendingPaymentForOrder(orderId: string): Promise<void>;
    handleRefund(midtransOrderId: string, refundReference: string): Promise<void>;
}
