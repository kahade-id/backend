import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ReportUserDto } from './dto/report-user.dto';
import { UpdateLinksDto } from './dto/update-links.dto';
import { CreateShowcaseDto, UpdateShowcaseDto } from './dto/showcase.dto';
import { OgMetadataService } from './og-metadata.service';
export declare class UsersService {
    private prisma;
    private redis;
    private configService;
    private auditLog;
    private ogMetadataService;
    private readonly logger;
    private s3Client;
    private s3Modules;
    constructor(prisma: PrismaService, redis: RedisService, configService: ConfigService, auditLog: AuditLogService, ogMetadataService: OgMetadataService);
    getMyProfile(userId: string): Promise<object>;
    updateProfile(userId: string, dto: UpdateProfileDto): Promise<object>;
    getPublicProfile(username: string, viewerId?: string): Promise<object>;
    getMyStats(userId: string): Promise<object>;
    searchUsers(query: string, page: number, limit: number, viewerId?: string): Promise<object>;
    checkUsernameAvailability(username: string): Promise<object>;
    private generateUsernameSuggestion;
    private invalidateUserOgCaches;
    private getNextRank;
    private normalizePagination;
    private getViewerExcludedIds;
    private getS3Client;
    uploadAvatar(userId: string, contentType?: string): Promise<{
        uploadUrl: string;
        avatarKey: string;
        expiresIn: number;
    }>;
    uploadAvatarDirect(userId: string, fileName: string, contentType: string, fileBuffer: Buffer): Promise<{
        avatarUrl: string;
    }>;
    confirmAvatar(userId: string, avatarKey: string): Promise<{
        avatarUrl: string;
    }>;
    deleteAvatar(userId: string): Promise<{
        message: string;
    }>;
    private detectImageMimeType;
    private extractKeyFromUrl;
    requestAccountDeletion(userId: string, currentAccessTokenJti?: string, password?: string, reason?: string, mfaCode?: string): Promise<{
        message: string;
    }>;
    getMyDevices(userId: string, page?: number, limit?: number): Promise<object>;
    removeDevice(userId: string, deviceId: string): Promise<{
        message: string;
    }>;
    private static readonly SECURITY_ACTIONS;
    getSecurityLog(userId: string, page: number, limit: number, actionFilter?: string): Promise<object>;
    private getTrustedDeviceExpiryDays;
    setDeviceTrust(userId: string, deviceId: string, trusted: boolean, password: string, mfaCode?: string): Promise<{
        message: string;
    }>;
    isDeviceTrustValid(trustedAt: Date | null): boolean;
    private maskIpAddress;
    getActivityLog(userId: string, page: number, limit: number): Promise<object>;
    getUserRatings(username: string, page: number, limit: number, filter?: string, viewerId?: string | null): Promise<object>;
    private withSerializableRetry;
    followUser(followerId: string, username: string): Promise<{
        message: string;
    }>;
    unfollowUser(followerId: string, username: string): Promise<{
        message: string;
    }>;
    getFollowers(username: string, page: number, limit: number, search?: string, viewerId?: string | null): Promise<object>;
    getFollowing(username: string, page: number, limit: number, viewerId?: string | null): Promise<object>;
    blockUser(blockerId: string, targetUserId: string): Promise<{
        message: string;
    }>;
    unblockUser(blockerId: string, targetUserId: string): Promise<{
        message: string;
    }>;
    getBlockedUsers(userId: string, page: number, limit: number): Promise<object>;
    reportUser(reporterId: string, targetUserId: string, dto: ReportUserDto): Promise<{
        message: string;
    }>;
    updateLinks(userId: string, dto: UpdateLinksDto): Promise<object>;
    getMyLinks(userId: string): Promise<object>;
    uploadHeader(userId: string, contentType?: string): Promise<{
        uploadUrl: string;
        headerKey: string;
        expiresIn: number;
    }>;
    confirmHeader(userId: string, headerKey: string): Promise<{
        headerUrl: string;
    }>;
    uploadHeaderDirect(userId: string, fileName: string, contentType: string, fileBuffer: Buffer): Promise<{
        headerUrl: string;
    }>;
    private isPubliclyAvailableSocialTarget;
    getFavorites(userId: string, page: number, limit: number): Promise<object>;
    checkFavorite(userId: string, username: string): Promise<{
        isFavorited: boolean;
    }>;
    addFavorite(userId: string, username: string): Promise<{
        message: string;
    }>;
    removeFavorite(userId: string, targetUserId: string): Promise<{
        message: string;
    }>;
    getSavedProfiles(userId: string, page: number, limit: number): Promise<object>;
    checkSavedProfile(userId: string, username: string): Promise<{
        isSaved: boolean;
    }>;
    saveProfile(userId: string, username: string): Promise<{
        message: string;
    }>;
    removeSavedProfile(userId: string, targetUserId: string): Promise<{
        message: string;
    }>;
    deleteHeader(userId: string): Promise<{
        message: string;
    }>;
    uploadShowcaseImage(userId: string, fileName: string, contentType: string, fileBuffer: Buffer): Promise<{
        imageUrl: string;
    }>;
    private readonly MAX_SHOWCASE_ITEMS;
    getShowcaseByUsername(username: string, viewerId?: string): Promise<object>;
    getMyShowcase(userId: string): Promise<object>;
    createShowcaseItem(userId: string, dto: CreateShowcaseDto): Promise<object>;
    updateShowcaseItem(userId: string, itemId: string, dto: UpdateShowcaseDto): Promise<object>;
    deleteShowcaseItem(userId: string, itemId: string): Promise<{
        message: string;
    }>;
}
