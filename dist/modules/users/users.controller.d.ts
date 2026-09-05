interface MulterFile {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}
import { UsersService } from './users.service';
import { UserSearchService } from './user-search.service';
import { UserStatsService } from './user-stats.service';
import { UserAnalyticsService } from './user-analytics.service';
import { ProfileQAService } from './profile-qa.service';
import { OgMetadataService } from './og-metadata.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ConfirmAvatarDto } from './dto/confirm-avatar.dto';
import { ReportUserDto } from './dto/report-user.dto';
import { UpdateLinksDto } from './dto/update-links.dto';
import { UploadAvatarDto } from './dto/upload-avatar.dto';
import { ConfirmHeaderDto } from './dto/confirm-header.dto';
import { RequestAccountDeletionDto } from './dto/request-account-deletion.dto';
import { AskQuestionDto, AnswerQuestionDto, AddCommentDto } from './dto/profile-question.dto';
import { CreateShowcaseDto, UpdateShowcaseDto } from './dto/showcase.dto';
import { TrustDeviceDto } from './dto/trust-device.dto';
export declare class UsersController {
    private usersService;
    private userSearchService;
    private userStatsService;
    private userAnalyticsService;
    private profileQAService;
    private ogMetadataService;
    constructor(usersService: UsersService, userSearchService: UserSearchService, userStatsService: UserStatsService, userAnalyticsService: UserAnalyticsService, profileQAService: ProfileQAService, ogMetadataService: OgMetadataService);
    getMyProfile(userId: string): Promise<object>;
    updateProfile(userId: string, dto: UpdateProfileDto): Promise<object>;
    getMyStats(userId: string): Promise<object>;
    getMyAnalytics(userId: string, period?: string): Promise<object>;
    getMyTrustScore(userId: string): Promise<object>;
    uploadAvatar(userId: string, dto: UploadAvatarDto): Promise<{
        uploadUrl: string;
        avatarKey: string;
        expiresIn: number;
    }>;
    confirmAvatar(userId: string, dto: ConfirmAvatarDto): Promise<{
        avatarUrl: string;
    }>;
    uploadAvatarDirect(userId: string, file: MulterFile): Promise<{
        avatarUrl: string;
    }>;
    deleteAvatar(userId: string): Promise<{
        message: string;
    }>;
    uploadHeader(userId: string, dto: UploadAvatarDto): Promise<{
        uploadUrl: string;
        headerKey: string;
        expiresIn: number;
    }>;
    confirmHeader(userId: string, dto: ConfirmHeaderDto): Promise<{
        headerUrl: string;
    }>;
    uploadHeaderDirect(userId: string, file: MulterFile): Promise<{
        headerUrl: string;
    }>;
    deleteHeader(userId: string): Promise<{
        message: string;
    }>;
    getMyLinks(userId: string): Promise<object>;
    updateLinks(userId: string, dto: UpdateLinksDto): Promise<object>;
    getBlockedUsers(userId: string, page: number, limit: number): Promise<object>;
    requestAccountDeletion(userId: string, accessTokenJti: string, dto: RequestAccountDeletionDto): Promise<{
        message: string;
    }>;
    getMyDevices(userId: string, page: number, limit: number): Promise<object>;
    removeDevice(userId: string, deviceId: string): Promise<{
        message: string;
    }>;
    trustDevice(userId: string, deviceId: string, dto: TrustDeviceDto): Promise<{
        message: string;
    }>;
    untrustDevice(userId: string, deviceId: string, dto: TrustDeviceDto): Promise<{
        message: string;
    }>;
    getSecurityLog(userId: string, page: number, limit: number, action?: string): Promise<object>;
    getActivityLog(userId: string, page: number, limit: number): Promise<object>;
    checkUsernameAvailability(username: string): Promise<object>;
    getFavorites(userId: string, page: number, limit: number): Promise<object>;
    getSavedProfiles(userId: string, page: number, limit: number): Promise<object>;
    searchUsers(userId: string, query: string, page: number, limit: number): Promise<object>;
    discoverUsers(userId: string, query: string, page: number, limit: number, minRating?: string, minTransactions?: string, isKycVerified?: string, membershipRank?: string): Promise<object>;
    getDashboardStats(userId: string): Promise<object>;
    uploadShowcaseImage(userId: string, file: MulterFile): Promise<{
        imageUrl: string;
    }>;
    getMyShowcase(userId: string): Promise<object>;
    createShowcaseItem(userId: string, dto: CreateShowcaseDto): Promise<object>;
    updateShowcaseItem(userId: string, itemId: string, dto: UpdateShowcaseDto): Promise<object>;
    deleteShowcaseItem(userId: string, itemId: string): Promise<{
        message: string;
    }>;
    getMyQuestions(userId: string, type: 'received' | 'asked', page: number, limit: number): Promise<object>;
    checkFavorite(userId: string, username: string): Promise<{
        isFavorited: boolean;
    }>;
    addFavorite(userId: string, username: string): Promise<{
        message: string;
    }>;
    removeFavorite(userId: string, username: string): Promise<{
        message: string;
    }>;
    checkSavedProfile(userId: string, username: string): Promise<{
        isSaved: boolean;
    }>;
    saveProfile(userId: string, username: string): Promise<{
        message: string;
    }>;
    removeSavedProfile(userId: string, username: string): Promise<{
        message: string;
    }>;
    blockUser(userId: string, targetUserId: string): Promise<{
        message: string;
    }>;
    unblockUser(userId: string, targetUserId: string): Promise<{
        message: string;
    }>;
    reportUser(userId: string, targetUserId: string, dto: ReportUserDto): Promise<{
        message: string;
    }>;
    getPublicProfile(username: string, viewerId: string | null): Promise<object>;
    getShowcase(username: string, viewerId: string | null): Promise<object>;
    followUser(userId: string, username: string): Promise<{
        message: string;
    }>;
    unfollowUser(userId: string, username: string): Promise<{
        message: string;
    }>;
    getFollowers(username: string, viewerId: string | null, page: number, limit: number, search?: string): Promise<object>;
    getFollowing(username: string, viewerId: string | null, page: number, limit: number): Promise<object>;
    getUserRatings(username: string, viewerId: string | null, page: number, limit: number, filter: string): Promise<object>;
    askQuestion(userId: string, username: string, dto: AskQuestionDto): Promise<object>;
    getProfileQuestions(username: string, page: number, limit: number): Promise<object>;
    answerQuestion(userId: string, questionId: string, dto: AnswerQuestionDto): Promise<object>;
    deleteQuestion(userId: string, questionId: string): Promise<{
        message: string;
    }>;
    addComment(userId: string, questionId: string, dto: AddCommentDto): Promise<object>;
    getComments(questionId: string, page: number, limit: number): Promise<object>;
    deleteComment(userId: string, commentId: string): Promise<{
        message: string;
    }>;
    getUserOgMetadata(username: string): Promise<object>;
}
export {};
