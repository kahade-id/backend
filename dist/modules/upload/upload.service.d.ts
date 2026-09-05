import { ConfigService } from '@nestjs/config';
import { UploadPurpose } from './dto/presigned-url.dto';
import { RedisService } from '../../redis/redis.service';
export declare class UploadService {
    private configService;
    private redis;
    private readonly logger;
    private _s3Client;
    constructor(configService: ConfigService, redis: RedisService);
    private getS3Client;
    private getPrivateBucket;
    private getPublicBucket;
    private getBucketForKey;
    generatePresignedUrl(userId: string, purpose: UploadPurpose, fileName: string, contentType: string, fileSize: number): Promise<{
        uploadUrl: string;
        fileKey: string;
        expiresIn: number;
        minFileSize: number;
        maxFileSize: number;
    }>;
    confirmUpload(userId: string, fileKey: string, sha256?: string): Promise<{
        fileKey: string;
        confirmed: boolean;
        sha256?: string;
        verified?: boolean;
    }>;
    isConfirmedUploadKey(userId: string, fileKey: string): Promise<boolean>;
    verifyEvidenceFileKeys(userId: string, fileKeys: string[], evidenceType?: 'dispute-evidence' | 'report-evidence'): Promise<void>;
    verifyEvidenceFileKeysBatch(userId: string, fileKeys: string[], fileTypes: string[], evidenceType?: 'dispute-evidence' | 'report-evidence'): Promise<{
        fileKey: string;
        fileType: string;
        status: 'ok' | 'error';
        error?: string;
    }[]>;
    verifyUserFileKeys(userId: string, fileKeys: string[], purpose: UploadPurpose): Promise<void>;
    getFileSize(fileKey: string): Promise<number>;
    generateDownloadUrl(fileKey: string, expiresIn?: number): Promise<string>;
    uploadPrivateAccountExport(userId: string, content: Buffer): Promise<{
        downloadUrl: string;
        expiresAt: Date;
    }>;
    uploadDirect(userId: string, purpose: UploadPurpose, fileName: string, contentType: string, fileBuffer: Buffer): Promise<{
        fileKey: string;
        fileUrl: string;
    }>;
    cleanupFileKeys(userId: string, fileKeys: string[]): Promise<{
        deleted: number;
        errors: {
            fileKey: string;
            reason: string;
        }[];
    }>;
    private isKnownStorageKey;
    private static readonly PURPOSE_FOLDER_MAP;
    private getBucket;
}
