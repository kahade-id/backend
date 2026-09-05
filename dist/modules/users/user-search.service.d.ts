import { PrismaService } from '../../prisma/prisma.service';
export declare class UserSearchService {
    private prisma;
    constructor(prisma: PrismaService);
    searchUsers(query: string, filters: {
        minRating?: number;
        minTransactions?: number;
        isKycVerified?: boolean;
        membershipRank?: string;
    }, page: number, limit: number, viewerId?: string): Promise<object>;
}
