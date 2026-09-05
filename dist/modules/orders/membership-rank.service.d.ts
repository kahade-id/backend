import { Prisma } from '@prisma/client';
export declare class MembershipRankService {
    private readonly logger;
    checkAndUpdateMembershipRank(tx: Prisma.TransactionClient, userId: string): Promise<void>;
}
