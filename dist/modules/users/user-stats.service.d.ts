import { PrismaService } from '../../prisma/prisma.service';
export declare class UserStatsService {
    private prisma;
    constructor(prisma: PrismaService);
    getDashboardStats(userId: string): Promise<object>;
}
