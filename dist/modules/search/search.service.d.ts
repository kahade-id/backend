import { PrismaService } from '../../prisma/prisma.service';
export declare class SearchService {
    private prisma;
    private readonly LIMIT;
    constructor(prisma: PrismaService);
    search(userId: string, query: string, types?: string[], limit?: number): Promise<object>;
    suggestions(userId: string, query: string, limit?: number): Promise<object>;
    private searchUsers;
    private searchOrders;
    private searchTransactions;
    private getBlockedUserIds;
    private normalizeQuery;
    private buildTsQuery;
}
