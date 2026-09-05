import { PrismaService } from '../../../prisma/prisma.service';
export declare class AdminReferralService {
    private prisma;
    constructor(prisma: PrismaService);
    getReferralStats(): Promise<object>;
    listReferralCodes(page: number, limit: number, isActive?: string): Promise<object>;
}
