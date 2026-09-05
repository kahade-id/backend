import {
  Controller, Get, Put, Patch, Delete, Post, Body, Query, Param,
  ParseIntPipe, DefaultValuePipe, BadRequestException, UseGuards,
  UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ParseUsernamePipe } from '../../common/pipes/parse-username.pipe';
import { ClampLimitPipe } from '../../common/pipes/clamp-limit.pipe';
import { ParseQueryStringPipe } from '../../common/pipes/parse-query-string.pipe';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

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
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { Public } from '../../common/decorators/public.decorator';
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
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';

@ApiTags('users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
  constructor(
    private usersService: UsersService,
    private userSearchService: UserSearchService,
    private userStatsService: UserStatsService,
    private userAnalyticsService: UserAnalyticsService,
    private profileQAService: ProfileQAService,
    private ogMetadataService: OgMetadataService,
  ) {}

  @Get('me')
  async getMyProfile(@CurrentUser('sub') userId: string): Promise<object> {
    return this.usersService.getMyProfile(userId);
  }

  @Put('me')
  @UseGuards(UserThrottleGuard)
  async updateProfile(@CurrentUser('sub') userId: string, @Body() dto: UpdateProfileDto): Promise<object> {
    return this.usersService.updateProfile(userId, dto);
  }

  @Get('me/stats')
  async getMyStats(@CurrentUser('sub') userId: string): Promise<object> {
    return this.usersService.getMyStats(userId);
  }

  @Get('me/analytics')
  @ApiOperation({ summary: 'Get user analytics dashboard data' })
  async getMyAnalytics(
    @CurrentUser('sub') userId: string,
    @Query('period', new ParseQueryStringPipe('period', 10)) period?: string,
  ): Promise<object> {
    return this.userAnalyticsService.getUserAnalytics(userId, period || '30d');
  }

  @Get('me/trust-score')
  @ApiOperation({ summary: 'Get user trust score and badge' })
  async getMyTrustScore(@CurrentUser('sub') userId: string): Promise<object> {
    const analytics = await this.userAnalyticsService.getUserAnalytics(userId, '30d');
    const score = (analytics as { overview: { trustScore: number } }).overview.trustScore;
    const badge = this.userAnalyticsService.getTrustBadge(score);
    return { score, badge };
  }

  @Put('me/avatar')
  @UseGuards(UserThrottleGuard)
  async uploadAvatar(
    @CurrentUser('sub') userId: string,
    @Body() dto: UploadAvatarDto,
  ): Promise<{ uploadUrl: string; avatarKey: string; expiresIn: number }> {
    return this.usersService.uploadAvatar(userId, dto?.contentType);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Post('me/avatar/confirm')
  async confirmAvatar(
    @CurrentUser('sub') userId: string,
    @Body() dto: ConfirmAvatarDto,
  ): Promise<{ avatarUrl: string }> {
    return this.usersService.confirmAvatar(userId, dto.avatarKey.trim());
  }

  @Post('me/avatar/direct')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Upload avatar directly through the server (bypasses CORS)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  async uploadAvatarDirect(
    @CurrentUser('sub') userId: string,
    @UploadedFile() file: MulterFile,
  ): Promise<{ avatarUrl: string }> {
    if (!file) {
      throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'File is required' });
    }
    return this.usersService.uploadAvatarDirect(userId, file.originalname, file.mimetype, file.buffer);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Delete('me/avatar')
  @UseGuards(UserThrottleGuard)
  async deleteAvatar(@CurrentUser('sub') userId: string): Promise<{ message: string }> {
    return this.usersService.deleteAvatar(userId);
  }

  @Put('me/header')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Get presigned URL for header image upload' })
  async uploadHeader(
    @CurrentUser('sub') userId: string,
    @Body() dto: UploadAvatarDto,
  ): Promise<{ uploadUrl: string; headerKey: string; expiresIn: number }> {
    return this.usersService.uploadHeader(userId, dto?.contentType);
  }

  @Post('me/header/confirm')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Confirm header image upload' })
  async confirmHeader(
    @CurrentUser('sub') userId: string,
    @Body() dto: ConfirmHeaderDto,
  ): Promise<{ headerUrl: string }> {
    return this.usersService.confirmHeader(userId, dto.headerKey.trim());
  }

  @Post('me/header/direct')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Upload header image directly through the server (bypasses CORS)' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  async uploadHeaderDirect(
    @CurrentUser('sub') userId: string,
    @UploadedFile() file: MulterFile,
  ): Promise<{ headerUrl: string }> {
    if (!file) {
      throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'File is required' });
    }
    return this.usersService.uploadHeaderDirect(userId, file.originalname, file.mimetype, file.buffer);
  }

  @Delete('me/header')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Delete header image' })
  async deleteHeader(@CurrentUser('sub') userId: string): Promise<{ message: string }> {
    return this.usersService.deleteHeader(userId);
  }

  @Get('me/links')
  @ApiOperation({ summary: 'Get my social links' })
  async getMyLinks(@CurrentUser('sub') userId: string): Promise<object> {
    return this.usersService.getMyLinks(userId);
  }

  @Put('me/links')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Update social links (replaces all)' })
  async updateLinks(@CurrentUser('sub') userId: string, @Body() dto: UpdateLinksDto): Promise<object> {
    return this.usersService.updateLinks(userId, dto);
  }

  @Get('me/blocked')
  @ApiOperation({ summary: 'List blocked users' })
  async getBlockedUsers(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.usersService.getBlockedUsers(userId, page, limit);
  }

  @Throttle({ default: { ttl: 86400000, limit: 3 } })
  @Post('me/delete-request')
  @UseGuards(UserThrottleGuard)
  async requestAccountDeletion(
    @CurrentUser('sub') userId: string,
    @CurrentUser('jti') accessTokenJti: string,
    @Body() dto: RequestAccountDeletionDto,
  ): Promise<{ message: string }> {
    return this.usersService.requestAccountDeletion(userId, accessTokenJti, dto.password, dto.reason, dto.mfaCode);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @UseGuards(UserThrottleGuard)
  @Get('me/devices')
  @ApiOperation({ summary: 'List logged-in devices' })
  async getMyDevices(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.usersService.getMyDevices(userId, page, limit);
  }

  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Delete('me/devices/:deviceId')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Remove/forget a device' })
  async removeDevice(
    @CurrentUser('sub') userId: string,
    @Param('deviceId', ParseIdPipe) deviceId: string,
  ): Promise<{ message: string }> {
    return this.usersService.removeDevice(userId, deviceId);
  }

  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Patch('me/devices/:deviceId/trust')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Mark a device as trusted (skip 2FA)' })
  async trustDevice(
    @CurrentUser('sub') userId: string,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Body() dto: TrustDeviceDto,
  ): Promise<{ message: string }> {
    return this.usersService.setDeviceTrust(userId, deviceId, true, dto.password, dto.mfaCode);
  }

  @Throttle({ default: { ttl: 900000, limit: 10 } })
  @Patch('me/devices/:deviceId/untrust')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Remove trust from a device' })
  async untrustDevice(
    @CurrentUser('sub') userId: string,
    @Param('deviceId', ParseIdPipe) deviceId: string,
    @Body() dto: TrustDeviceDto,
  ): Promise<{ message: string }> {
    return this.usersService.setDeviceTrust(userId, deviceId, false, dto.password, dto.mfaCode);
  }

  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @UseGuards(UserThrottleGuard)
  @Get('me/security-log')
  @ApiOperation({ summary: 'View security-related activity log' })
  async getSecurityLog(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
    @Query('action', new ParseQueryStringPipe('action', 50)) action?: string,
  ): Promise<object> {
    return this.usersService.getSecurityLog(userId, page, limit, action);
  }

  @Get('me/activity-log')
  @ApiOperation({ summary: 'View own activity log' })
  async getActivityLog(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.usersService.getActivityLog(userId, page, limit);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Get('availability')
  async checkUsernameAvailability(@Query('username') username: string): Promise<object> {
    if (!username || username.trim().length < 3) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'username must be at least 3 characters' });
    }
    if (username.length > 50) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'username must not exceed 50 characters' });
    }
    return this.usersService.checkUsernameAvailability(username);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('favorites')
  @ApiOperation({ summary: 'List favorite users' })
  async getFavorites(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.usersService.getFavorites(userId, page, limit);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('saved')
  @ApiOperation({ summary: 'List saved profiles' })
  async getSavedProfiles(
    @CurrentUser('sub') userId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.usersService.getSavedProfiles(userId, page, limit);
  }

  // B-12 (audit-fix): tighten user-search rate limit. Search exposes
  // username/full-name patterns that are useful for enumeration; 20 rpm/IP
  // is enough for legitimate UX but too generous for scraping. Drop to 10
  // rpm/IP and keep the per-user throttle (Throttler key already mixes user).
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Get('search')
  async searchUsers(
    @CurrentUser('sub') userId: string,
    @Query('q', new ParseQueryStringPipe('q', 200)) query: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    if (!query || query.trim().length < 2) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Search query must be at least 2 characters' });
    }
    return this.usersService.searchUsers(query, page, limit, userId);
  }

  // B-12 (audit-fix): same as searchUsers above; discover is a richer query
  // and even more enumeration-friendly. 30 rpm/IP -> 15 rpm/IP.
  @Throttle({ default: { ttl: 60000, limit: 15 } })
  @Get('discover')
  @ApiOperation({ summary: 'Search & discover users with filters' })
  async discoverUsers(
    @CurrentUser('sub') userId: string,
    @Query('q', new ParseQueryStringPipe('q', 200)) query: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
    @Query('minRating', new ParseQueryStringPipe('minRating', 5)) minRating?: string,
    @Query('minTransactions', new ParseQueryStringPipe('minTransactions', 10)) minTransactions?: string,
    @Query('isKycVerified', new ParseQueryStringPipe('isKycVerified', 5)) isKycVerified?: string,
    @Query('membershipRank', new ParseQueryStringPipe('membershipRank', 20)) membershipRank?: string,
  ): Promise<object> {
    return this.userSearchService.searchUsers(query || '', {
      minRating: minRating ? Number(minRating) : undefined,
      minTransactions: minTransactions ? Number(minTransactions) : undefined,
      isKycVerified: isKycVerified === 'true',
      membershipRank,
    }, page, limit, userId);
  }

  @Get('me/dashboard')
  @ApiOperation({ summary: 'Get dashboard statistics' })
  async getDashboardStats(@CurrentUser('sub') userId: string): Promise<object> {
    return this.userStatsService.getDashboardStats(userId);
  }

  @Post('me/showcase/upload')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Upload showcase item image directly' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async uploadShowcaseImage(
    @CurrentUser('sub') userId: string,
    @UploadedFile() file: MulterFile,
  ): Promise<{ imageUrl: string }> {
    if (!file) {
      throw new BadRequestException({ code: 'FILE_REQUIRED', message: 'File is required' });
    }
    return this.usersService.uploadShowcaseImage(userId, file.originalname, file.mimetype, file.buffer);
  }

  @Get('me/showcase')
  @ApiOperation({ summary: 'Get my showcase items (including inactive)' })
  async getMyShowcase(@CurrentUser('sub') userId: string): Promise<object> {
    return this.usersService.getMyShowcase(userId);
  }

  @Post('me/showcase')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Add a showcase item' })
  async createShowcaseItem(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateShowcaseDto,
  ): Promise<object> {
    return this.usersService.createShowcaseItem(userId, dto);
  }

  @Put('me/showcase/:id')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Update a showcase item' })
  async updateShowcaseItem(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseIdPipe) itemId: string,
    @Body() dto: UpdateShowcaseDto,
  ): Promise<object> {
    return this.usersService.updateShowcaseItem(userId, itemId, dto);
  }

  @Delete('me/showcase/:id')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Delete a showcase item' })
  async deleteShowcaseItem(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseIdPipe) itemId: string,
  ): Promise<{ message: string }> {
    return this.usersService.deleteShowcaseItem(userId, itemId);
  }

  @Get('me/questions')
  @ApiOperation({ summary: 'Get my received or asked questions' })
  async getMyQuestions(
    @CurrentUser('sub') userId: string,
    @Query('type', new DefaultValuePipe('received')) type: 'received' | 'asked',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.profileQAService.getMyQuestions(userId, type, page, limit);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':username/favorite')
  @ApiOperation({ summary: 'Check if a user is in favorites' })
  async checkFavorite(
    @CurrentUser('sub') userId: string,
    @Param('username', ParseUsernamePipe) username: string,
  ): Promise<{ isFavorited: boolean }> {
    return this.usersService.checkFavorite(userId, username);
  }

  @Post(':username/favorite')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Add user to favorites' })
  async addFavorite(
    @CurrentUser('sub') userId: string,
    @Param('username', ParseUsernamePipe) username: string,
  ): Promise<{ message: string }> {
    return this.usersService.addFavorite(userId, username);
  }

  @Delete(':username/favorite')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Remove user from favorites' })
  async removeFavorite(
    @CurrentUser('sub') userId: string,
    @Param('username', ParseUsernamePipe) username: string,
  ): Promise<{ message: string }> {
    return this.usersService.removeFavorite(userId, username);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':username/saved')
  @ApiOperation({ summary: 'Check if a profile is saved' })
  async checkSavedProfile(
    @CurrentUser('sub') userId: string,
    @Param('username', ParseUsernamePipe) username: string,
  ): Promise<{ isSaved: boolean }> {
    return this.usersService.checkSavedProfile(userId, username);
  }

  @Post(':username/saved')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Save a profile' })
  async saveProfile(
    @CurrentUser('sub') userId: string,
    @Param('username', ParseUsernamePipe) username: string,
  ): Promise<{ message: string }> {
    return this.usersService.saveProfile(userId, username);
  }

  @Delete(':username/saved')
  @UseGuards(UserThrottleGuard)
  @Idempotency()
  @ApiOperation({ summary: 'Remove a saved profile' })
  async removeSavedProfile(
    @CurrentUser('sub') userId: string,
    @Param('username', ParseUsernamePipe) username: string,
  ): Promise<{ message: string }> {
    return this.usersService.removeSavedProfile(userId, username);
  }

  @Post(':userId/block')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Block a user' })
  async blockUser(
    @CurrentUser('sub') userId: string,
    @Param('userId', ParseIdPipe) targetUserId: string,
  ): Promise<{ message: string }> {
    return this.usersService.blockUser(userId, targetUserId);
  }

  @Delete(':userId/block')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Unblock a user' })
  async unblockUser(
    @CurrentUser('sub') userId: string,
    @Param('userId', ParseIdPipe) targetUserId: string,
  ): Promise<{ message: string }> {
    return this.usersService.unblockUser(userId, targetUserId);
  }

  @Post(':userId/report')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 86400000, limit: 5 } })
  @ApiOperation({ summary: 'Report a user' })
  async reportUser(
    @CurrentUser('sub') userId: string,
    @Param('userId', ParseIdPipe) targetUserId: string,
    @Body() dto: ReportUserDto,
  ): Promise<{ message: string }> {
    return this.usersService.reportUser(userId, targetUserId, dto);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':username')
  async getPublicProfile(
    @Param('username', ParseUsernamePipe) username: string,
    @CurrentUser('sub') viewerId: string | null,
  ): Promise<object> {
    if (!username || username.length > 30 || !/^[a-zA-Z0-9_.-]+$/.test(username)) {
      throw new BadRequestException({ code: 'INVALID_USERNAME', message: 'Invalid username format' });
    }
    return this.usersService.getPublicProfile(username, viewerId ?? undefined);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':username/showcase')
  @ApiOperation({ summary: 'Get public showcase items for a user' })
  async getShowcase(
    @Param('username', ParseUsernamePipe) username: string,
    @CurrentUser('sub') viewerId: string | null,
  ): Promise<object> {
    return this.usersService.getShowcaseByUsername(username, viewerId ?? undefined);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Post(':username/follow')
  @ApiOperation({ summary: 'Follow a user' })
  async followUser(
    @CurrentUser('sub') userId: string,
    @Param('username', ParseUsernamePipe) username: string,
  ): Promise<{ message: string }> {
    return this.usersService.followUser(userId, username);
  }

  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseGuards(UserThrottleGuard)
  @Delete(':username/follow')
  @ApiOperation({ summary: 'Unfollow a user' })
  async unfollowUser(
    @CurrentUser('sub') userId: string,
    @Param('username', ParseUsernamePipe) username: string,
  ): Promise<{ message: string }> {
    return this.usersService.unfollowUser(userId, username);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get(':username/followers')
  @ApiOperation({ summary: 'List followers of a user' })
  async getFollowers(
    @Param('username', ParseUsernamePipe) username: string,
    @CurrentUser('sub') viewerId: string | null,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
    @Query('search', new ParseQueryStringPipe('search', 100)) search?: string,
  ): Promise<object> {
    return this.usersService.getFollowers(username, page, limit, search, viewerId);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get(':username/following')
  @ApiOperation({ summary: 'List users followed by a user' })
  async getFollowing(
    @Param('username', ParseUsernamePipe) username: string,
    @CurrentUser('sub') viewerId: string | null,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.usersService.getFollowing(username, page, limit, viewerId);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Get(':username/ratings')
  async getUserRatings(
    @Param('username', ParseUsernamePipe) username: string,
    @CurrentUser('sub') viewerId: string | null,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe, new ClampLimitPipe()) limit: number,
    @Query('filter', new ParseQueryStringPipe('filter', 20)) filter: string,
  ): Promise<object> {
    return this.usersService.getUserRatings(username, page, limit, filter, viewerId);
  }

  @Post(':username/questions')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Ask a question on user profile' })
  async askQuestion(
    @CurrentUser('sub') userId: string,
    @Param('username', ParseUsernamePipe) username: string,
    @Body() dto: AskQuestionDto,
  ): Promise<object> {
    return this.profileQAService.askQuestion(userId, username, dto.question);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':username/questions')
  @ApiOperation({ summary: 'Get public Q&A for a profile' })
  async getProfileQuestions(
    @Param('username', ParseUsernamePipe) username: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.profileQAService.getProfileQuestions(username, page, limit);
  }

  @Put('questions/:questionId/answer')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Answer a profile question' })
  async answerQuestion(
    @CurrentUser('sub') userId: string,
    @Param('questionId', ParseIdPipe) questionId: string,
    @Body() dto: AnswerQuestionDto,
  ): Promise<object> {
    return this.profileQAService.answerQuestion(userId, questionId, dto.answer);
  }

  @Delete('questions/:questionId')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Delete a question' })
  async deleteQuestion(
    @CurrentUser('sub') userId: string,
    @Param('questionId', ParseIdPipe) questionId: string,
  ): Promise<{ message: string }> {
    return this.profileQAService.deleteQuestion(userId, questionId);
  }

  @Post('questions/:questionId/comments')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Add a comment to a Q&A thread' })
  async addComment(
    @CurrentUser('sub') userId: string,
    @Param('questionId', ParseIdPipe) questionId: string,
    @Body() dto: AddCommentDto,
  ): Promise<object> {
    return this.profileQAService.addComment(userId, questionId, dto.content, dto.parentId);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('questions/:questionId/comments')
  @ApiOperation({ summary: 'Get comments for a Q&A thread' })
  async getComments(
    @Param('questionId', ParseIdPipe) questionId: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe, new ClampLimitPipe()) limit: number,
  ): Promise<object> {
    return this.profileQAService.getComments(questionId, page, limit);
  }

  @Delete('comments/:commentId')
  @UseGuards(UserThrottleGuard)
  @ApiOperation({ summary: 'Delete a comment' })
  async deleteComment(
    @CurrentUser('sub') userId: string,
    @Param('commentId', ParseIdPipe) commentId: string,
  ): Promise<{ message: string }> {
    return this.profileQAService.deleteComment(userId, commentId);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get(':username/og')
  @ApiOperation({ summary: 'Get OG metadata for user profile' })
  async getUserOgMetadata(@Param('username', ParseUsernamePipe) username: string): Promise<object> {
    return this.ogMetadataService.getUserOgMetadata(username);
  }
}
