import { Rating } from '@prisma/client';
import { RatingsService } from './ratings.service';
import { RatingReplyService } from './rating-reply.service';
import { CreateRatingDto } from './dto/create-rating.dto';
import { UpdateRatingDto } from './dto/update-rating.dto';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
export declare class RatingReplyDto {
    content: string;
}
export declare class RatingsController {
    private ratingsService;
    private ratingReplyService;
    constructor(ratingsService: RatingsService, ratingReplyService: RatingReplyService);
    createRating(userId: string, dto: CreateRatingDto): Promise<Rating>;
    getMyRatings(userId: string, pagination: PaginationDto): Promise<{
        given: PaginatedResponse<Record<string, unknown>>;
        received: PaginatedResponse<Record<string, unknown>>;
    }>;
    updateRating(userId: string, ratingId: string, dto: UpdateRatingDto): Promise<Rating>;
    replyToRating(userId: string, ratingId: string, dto: RatingReplyDto): Promise<object>;
    updateReply(userId: string, replyId: string, dto: RatingReplyDto): Promise<object>;
    deleteReply(userId: string, replyId: string): Promise<{
        message: string;
    }>;
}
