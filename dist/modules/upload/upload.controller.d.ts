interface MulterFile {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
}
import { UploadService } from './upload.service';
import { PresignedUrlDto } from './dto/presigned-url.dto';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';
declare class CleanupFilesDto {
    fileKeys: string[];
}
export declare class UploadController {
    private uploadService;
    constructor(uploadService: UploadService);
    getPresignedUrl(userId: string, dto: PresignedUrlDto): Promise<{
        uploadUrl: string;
        fileKey: string;
        expiresIn: number;
        minFileSize: number;
        maxFileSize: number;
    }>;
    confirmUpload(userId: string, dto: ConfirmUploadDto): Promise<{
        fileKey: string;
        confirmed: boolean;
        sha256?: string;
        verified?: boolean;
    }>;
    uploadDirect(userId: string, file: MulterFile, purpose: string): Promise<{
        fileKey: string;
        fileUrl: string;
    }>;
    cleanupFiles(userId: string, dto: CleanupFilesDto): Promise<{
        deleted: number;
        errors: {
            fileKey: string;
            reason: string;
        }[];
    }>;
}
export {};
