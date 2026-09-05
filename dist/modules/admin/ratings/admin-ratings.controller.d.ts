import { AdminRatingsService } from './admin-ratings.service';
import { PaginatedResponse } from '../../../common/dto/pagination.dto';
import { RatingListQueryDto } from './dto/rating-list-query.dto';
import { RatingActionDto } from './dto/rating-action.dto';
import { Request } from 'express';
export declare class AdminRatingsController {
    private readonly service;
    constructor(service: AdminRatingsService);
    listRatings(query: RatingListQueryDto): Promise<PaginatedResponse<Record<string, unknown>>>;
    removeRating(ratingId: string, adminId: string, req: Request, dto: RatingActionDto): Promise<{
        message: string;
        ratingId: string;
    }>;
    unhideRating(ratingId: string, adminId: string, req: Request, dto: RatingActionDto): Promise<{
        message: string;
        ratingId: string;
    }>;
}
