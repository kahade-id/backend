import { PrismaService } from '../../prisma/prisma.service';
export declare class UserAnalyticsService {
    private prisma;
    constructor(prisma: PrismaService);
    getUserAnalytics(userId: string, period?: string): Promise<{
        overview: {
            totalOrders: number;
            totalCompleted: number;
            totalCancelled: number;
            totalDisputed: number;
            totalVolume: number;
            avgRating: number;
            ratingCount: number;
            membershipRank: import("@prisma/client").$Enums.MembershipRank;
            memberSince: Date;
            trustScore: number;
        };
        period: {
            days: number;
            ordersTotal: number;
            ordersCompleted: number;
            ordersCancelled: number;
            ordersDisputed: number;
            asBuyer: number;
            asSeller: number;
            volume: number;
            topups: number;
            withdrawals: number;
            ratingsReceived: number;
            avgRatingInPeriod: number | null;
        };
        charts: {
            ordersByDay: Record<string, number>;
            ratingTrend: {
                date: string;
                stars: number;
            }[];
        };
        monthlyVolume: {
            count: number;
            volume: number;
        };
    }>;
    calculateTrustScore(user: {
        totalOrdersCompleted: number;
        totalOrdersCancelled: number;
        totalOrdersDisputed: number;
        averageRating: unknown;
        totalRatingCount: number;
        kycStatus: string;
        isKahadePlus: boolean;
        createdAt: Date;
    }): number;
    getTrustBadge(score: number): {
        label: string;
        labelEn: string;
        color: string;
    };
}
