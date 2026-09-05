import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletTxSerialService } from '../../common/services/wallet-tx-serial.service';
export declare class ScheduledWithdrawalService {
    private prisma;
    private walletTxSerialService;
    private configService;
    private readonly logger;
    private readonly minWithdraw;
    private readonly maxWithdrawPerTx;
    private readonly dailyWithdrawLimit;
    constructor(prisma: PrismaService, walletTxSerialService: WalletTxSerialService, configService: ConfigService);
    private getHeldEscrowReleaseAmount;
    processScheduledWithdrawal(scheduleId: string): Promise<{
        skipped: boolean;
        reason?: string;
    }>;
    createSchedule(userId: string, dto: {
        bankAccountId: string;
        dayOfWeek: number;
        minAmount?: number;
    }): Promise<object>;
    getSchedules(userId: string): Promise<object[]>;
    updateSchedule(userId: string, scheduleId: string, dto: {
        dayOfWeek?: number;
        minAmount?: number;
        isActive?: boolean;
        bankAccountId?: string;
    }): Promise<object>;
    deleteSchedule(userId: string, scheduleId: string): Promise<{
        message: string;
    }>;
    private formatSchedule;
    private validateScheduleMinimum;
}
