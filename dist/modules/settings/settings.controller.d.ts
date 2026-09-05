import { SettingsService } from './settings.service';
import { PaginationDto, PaginatedResponse } from '../../common/dto/pagination.dto';
import { ReportUserSettingsDto } from './dto/report-user.dto';
import { UpdatePrivacyDto } from './dto/update-privacy.dto';
import { UpdateLanguageDto } from './dto/update-language.dto';
export declare class SettingsController {
    private readonly settingsService;
    constructor(settingsService: SettingsService);
    listBlockedUsers(userId: string, pagination: PaginationDto): Promise<PaginatedResponse<Record<string, unknown>>>;
    blockUser(currentUserId: string, targetUserId: string): Promise<{
        message: string;
    }>;
    unblockUser(currentUserId: string, targetUserId: string): Promise<{
        message: string;
    }>;
    reportUser(userId: string, dto: ReportUserSettingsDto): Promise<{
        message: string;
        reportId: string;
    }>;
    listMyReports(userId: string, pagination: PaginationDto): Promise<PaginatedResponse<Record<string, unknown>>>;
    getPrivacySettings(userId: string): Promise<{
        profileVisible: boolean;
        showOnlineStatus: boolean;
    }>;
    updatePrivacySettings(userId: string, dto: UpdatePrivacyDto): Promise<{
        profileVisible: boolean;
        showOnlineStatus: boolean;
        message: string;
    }>;
    getLanguage(userId: string): Promise<{
        language: string;
    }>;
    updateLanguage(userId: string, dto: UpdateLanguageDto): Promise<{
        language: string;
        message: string;
    }>;
    requestDataExport(userId: string): Promise<{
        message: string;
        downloadUrl: string;
        expiresAt: Date;
    }>;
}
