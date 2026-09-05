import { Rating } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRatingDto } from './dto/create-rating.dto';
import { UpdateRatingDto } from './dto/update-rating.dto';
import { PaginatedResponse } from '../../common/dto/pagination.dto';
export declare class RatingsService {
    private prisma;
    private readonly logger;
    private readonly RATING_WINDOW_DAYS;
    private readonly EDIT_WINDOW_DAYS;
    constructor(prisma: PrismaService);
    createRating(userId: string, dto: CreateRatingDto): Promise<Rating>;
    getMyRatings(userId: string, page: number, limit: number): Promise<{
        given: PaginatedResponse<Record<string, unknown>>;
        received: PaginatedResponse<Record<string, unknown>> & {
            averageRating: number;
            ratingCount: number;
        };
    }>;
    updateRating(userId: string, ratingId: string, dto: UpdateRatingDto): Promise<Rating>;
    private updateReceiverStatsInTx;
}
