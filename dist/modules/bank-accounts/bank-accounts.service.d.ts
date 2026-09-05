import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MidtransService } from '../payment/midtrans.service';
export declare class BankAccountsService {
    private prisma;
    private midtransService;
    private configService;
    private readonly logger;
    constructor(prisma: PrismaService, midtransService: MidtransService, configService: ConfigService);
    listBankAccounts(userId: string): Promise<{
        bankAccounts: Array<Record<string, unknown>>;
    }>;
    addBankAccount(userId: string, bankCode: string, bankName: string, accountNumber: string, accountName: string): Promise<Record<string, unknown>>;
    deleteBankAccount(userId: string, bankAccountId: string): Promise<{
        message: string;
    }>;
    setPrimaryBankAccount(userId: string, bankAccountId: string): Promise<Record<string, unknown>>;
}
