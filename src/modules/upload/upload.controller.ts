import { Controller, Post, Get, Body, Query, UseInterceptors, UploadedFile, BadRequestException, ForbiddenException, GoneException, HttpCode, UseGuards, StreamableFile, Header } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsArray, IsString, ArrayMaxSize, ArrayMinSize } from 'class-validator';
import { Readable } from 'stream';
import { PhoneVerifiedGuard } from '../../common/guards/phone-verified.guard';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { Public } from '../../common/decorators/public.decorator';
import { isPrivateFileKey, isSafeFileKey } from './upload.service';

interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}
import { UploadService } from './upload.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PresignedUrlDto, UploadPurpose } from './dto/presigned-url.dto';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';

class CleanupFilesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  fileKeys!: string[];
}

@ApiTags('upload')
@ApiBearerAuth('access-token')
@UseGuards(PhoneVerifiedGuard)
@Controller('upload')
export class UploadController {
  constructor(private uploadService: UploadService) {}

  @UseGuards(UserThrottleGuard)
  @Post('presigned-url')
  @ApiOperation({
    summary: '[DEPRECATED — 410 Gone] Generate pre-signed upload URL',
    description:
      'SS-016: alur presigned dihapus 2026-09-26 (R2 → storage self-hosted). ' +
      'Selalu 410. Gunakan POST /v1/upload/direct (multipart).',
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async getPresignedUrl(
    @CurrentUser('sub') userId: string,
    @Body() dto: PresignedUrlDto,
  ): Promise<{ uploadUrl: string; fileKey: string; expiresIn: number; minFileSize: number; maxFileSize: number }> {
    throw new GoneException({
      code: 'DEPRECATED',
      message: 'Presigned URL upload is no longer supported. Use POST /v1/upload/direct instead.',
    });
  }

  @UseGuards(UserThrottleGuard)
  @Post('confirm')
  @ApiOperation({
    summary: '[DEPRECATED — 410 Gone] Confirm file upload was completed',
    description:
      'SS-016: bagian dari alur presigned yang sudah dihapus. Selalu 410. ' +
      'Gunakan POST /v1/upload/direct (multipart).',
  })
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  async confirmUpload(
    @CurrentUser('sub') userId: string,
    @Body() dto: ConfirmUploadDto,
  ): Promise<{ fileKey: string; confirmed: boolean; sha256?: string; verified?: boolean }> {
    throw new GoneException({
      code: 'DEPRECATED',
      message: 'Presigned upload confirmation is no longer supported. Use POST /v1/upload/direct instead.',
    });
  }

  @UseGuards(UserThrottleGuard)
  @Post('direct')
  @ApiOperation({ summary: 'Upload file directly through the server (bypasses CORS)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'purpose'],
      properties: {
        file: { type: 'string', format: 'binary' },
        purpose: { type: 'string', enum: Object.values(UploadPurpose) },
      },
    },
  })
  // Batch 1A (ST-009): batas multer diselaraskan ke batas purpose maksimum
  // (50 MB untuk CHAT_ATTACHMENT / DISPUTE_EVIDENCE). Validasi per-purpose
  // tetap ditegakkan di UploadService.uploadDirect() — multer hanya guard kasar.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }))
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async uploadDirect(
    @CurrentUser('sub') userId: string,
    @UploadedFile() file: MulterFile,
    @Body('purpose') purpose: string,
  ): Promise<{ fileKey: string; fileUrl: string }> {
    if (!file) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'File is required' });
    }
    if (!purpose || !Object.values(UploadPurpose).includes(purpose as UploadPurpose)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Invalid purpose. Must be one of: ${Object.values(UploadPurpose).join(', ')}`,
      });
    }
    return this.uploadService.uploadDirect(
      userId,
      purpose as UploadPurpose,
      file.originalname,
      file.mimetype,
      file.buffer,
    );
  }

  @UseGuards(UserThrottleGuard)
  @Post('cleanup')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete previously uploaded files (rollback partial uploads)' })
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  async cleanupFiles(
    @CurrentUser('sub') userId: string,
    @Body() dto: CleanupFilesDto,
  ): Promise<{ deleted: number; errors: { fileKey: string; reason: string }[] }> {
    return this.uploadService.cleanupFileKeys(userId, dto.fileKeys);
  }

  // ── Batch 1A (ST-002/ST-006/03-#1): download file privat ──
  // Menggantikan semantik presigned-URL R2. URL dibuat server-side via
  // UploadService.generateDownloadUrl() SETELAH otorisasi pemanggil
  // (admin-kyc, disputes, chat, dsb.), sehingga signed URL = capability
  // yang kedaluwarsa — aman dipakai di <img> / komponen image mobile.

  @Public()
  @Get('s')
  @ApiOperation({ summary: 'Download private file via signed URL (HMAC + expiry)' })
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadSigned(
    @Query('key') key: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
  ): Promise<StreamableFile> {
    if (!key || !exp || !sig) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Missing signed URL parameters' });
    }
    const fileKey = this.uploadService.verifySignedDownload(key, exp, sig);
    if (!fileKey) {
      // 403 generik — jangan bocorkan apakah key ada / signature salah / expired.
      throw new ForbiddenException({ code: 'FILE_ACCESS_DENIED', message: 'Invalid or expired download link' });
    }
    const { stream, contentType, size } = await this.uploadService.getPrivateFileStream(fileKey);
    return new StreamableFile(stream, { type: contentType, length: size });
  }

  @Get('my-file')
  @ApiOperation({ summary: 'Download own private file (authenticated owner)' })
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Header('X-Content-Type-Options', 'nosniff')
  async downloadOwnFile(
    @CurrentUser('sub') userId: string,
    @Query('key') key: string,
  ): Promise<StreamableFile> {
    if (!key || typeof key !== 'string') {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Missing file key' });
    }
    // SH-S-004: validasi BENTUK key dulu (fail-closed, 400 terkontrol) sebelum
    // parsing segmen — mencegah pola traversal/key aneh mencapai logika akses.
    if (!isSafeFileKey(key)) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid file key format' });
    }
    // Kepemilikan: segmen userId pada key harus sama dengan peminta.
    const segments = key.split('/');
    if (segments.length !== 4 || segments[2] !== userId || !isPrivateFileKey(key)) {
      throw new BadRequestException({ code: 'FILE_ACCESS_DENIED', message: 'File not found' });
    }
    const { stream, contentType, size } = await this.uploadService.getPrivateFileStream(key);
    return new StreamableFile(stream, { type: contentType, length: size });
  }
}
