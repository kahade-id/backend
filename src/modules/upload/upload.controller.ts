import { Controller, Post, Get, Body, Query, Param, ParseIntPipe, UseInterceptors, UploadedFile, BadRequestException, ForbiddenException, GoneException, HttpCode, UseGuards, StreamableFile, Header, Injectable, ExecutionContext, CallHandler, NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
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
import { UploadService, DirectUploadResult } from './upload.service';
import { ChunkedUploadService, ChunkedInitResult, ChunkStatusResult } from './chunked-upload.service';
import { InitChunkedUploadDto } from './dto/chunked-upload.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PresignedUrlDto, UploadPurpose } from './dto/presigned-url.dto';
import { ConfirmUploadDto } from './dto/confirm-upload.dto';
import { UPLOAD_DIRECT_MULTER_MAX_BYTES } from '../../common/constants/app.constants';

class CleanupFilesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  fileKeys!: string[];
}

/**
 * BFI-106 (audit integrasi 2026-09-30): guard multer `fileSize` melempar 413
 * SEBELUM handler berjalan (celah 100–105 MiB untuk video). Nest mengubah
 * MulterError LIMIT_FILE_SIZE menjadi `PayloadTooLargeException("File too
 * large")` TANPA kode terstruktur → HttpExceptionFilter memetakannya jadi
 * `{ code: 'UNKNOWN_ERROR' }` yang tidak bisa dipetakan FE.
 *
 * Interceptor ini (terdaftar di level controller → membungkus FileInterceptor
 * yang ada di level method) menangkap 413 mentah tersebut dan melempar ulang
 * sebagai 413 `{ code: 'PAYLOAD_TOO_LARGE' }`. Exception terstruktur dari kode
 * sendiri (VIDEO_TOO_LARGE / FILE_TOO_LARGE — respons objek yang sudah
 * ber-`code`, lihat BFI-060) diteruskan APA ADANYA.
 */
@Injectable()
class MulterTooLargeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (err instanceof PayloadTooLargeException) {
          const response = err.getResponse();
          const alreadyStructured =
            typeof response === 'object' &&
            response !== null &&
            typeof (response as Record<string, unknown>).code === 'string';
          if (!alreadyStructured) {
            return throwError(
              () =>
                new PayloadTooLargeException({
                  code: 'PAYLOAD_TOO_LARGE',
                  message: 'File too large. The upload exceeds the maximum allowed size.',
                }),
            );
          }
        }
        return throwError(() => err);
      }),
    );
  }
}

@ApiTags('upload')
@ApiBearerAuth('access-token')
@UseGuards(PhoneVerifiedGuard)
@UseInterceptors(MulterTooLargeInterceptor)
@Controller('upload')
export class UploadController {
  constructor(
    private uploadService: UploadService,
    private chunkedUploadService: ChunkedUploadService,
  ) {}

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
  // (105 MiB — sedikit di atas batas video showcase 100 MiB, batch 19 TIM A).
  // Validasi per-purpose tetap ditegakkan di UploadService.uploadDirect() —
  // multer hanya guard kasar.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: UPLOAD_DIRECT_MULTER_MAX_BYTES } }))
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async uploadDirect(
    @CurrentUser('sub') userId: string,
    @UploadedFile() file: MulterFile,
    @Body('purpose') purpose: string,
  ): Promise<DirectUploadResult> {
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

  // ── NP-006 (perf-fix, 2026-09-29): upload chunked/resumable ──
  // Protokol 4 langkah untuk file besar (video showcase s/d 100 MiB):
  // init → chunk* → status (resume) → complete. Gagal di tengah = lanjutkan
  // dari chunk terakhir yang diterima, BUKAN dari nol. Additive-only:
  // endpoint baru; `POST /v1/upload/direct` tidak berubah.

  @UseGuards(UserThrottleGuard)
  @Post('chunked/init')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Start a resumable chunked upload session',
    description:
      'NP-006: validasi purpose/batas ukuran/MIME di awal (gagal cepat). ' +
      'Mengembalikan sessionId + chunkSize/totalChunks yang disepakati server. ' +
      'Sesi kedaluwarsa 24 jam.',
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async initChunkedUpload(
    @CurrentUser('sub') userId: string,
    @Body() dto: InitChunkedUploadDto,
  ): Promise<ChunkedInitResult> {
    return this.chunkedUploadService.initiate(userId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Post('chunked/:sessionId/chunk')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Upload one chunk of a resumable session',
    description:
      'NP-006: multipart `chunk` (biner) + field `chunkIndex`. Idempoten — ' +
      'kirim ulang chunk yang sama (byte identik) mengembalikan 200.',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('chunk', { limits: { fileSize: 8 * 1024 * 1024 + 64 * 1024 } }))
  @Throttle({ default: { ttl: 60000, limit: 120 } })
  async uploadChunk(
    @CurrentUser('sub') userId: string,
    @Param('sessionId') sessionId: string,
    @Body('chunkIndex', ParseIntPipe) chunkIndex: number,
    @UploadedFile() file: MulterFile,
  ): Promise<ChunkStatusResult> {
    if (!file) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Chunk file is required' });
    }
    return this.chunkedUploadService.uploadChunk(userId, sessionId, chunkIndex, {
      buffer: file.buffer,
      size: file.size,
    });
  }

  @UseGuards(UserThrottleGuard)
  @Get('chunked/:sessionId/status')
  @ApiOperation({
    summary: 'List received chunks of a session (for resume)',
    description: 'NP-006: client memakai `received` untuk mengirim HANYA chunk yang hilang.',
  })
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  async chunkedStatus(
    @CurrentUser('sub') userId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<ChunkStatusResult> {
    return this.chunkedUploadService.status(userId, sessionId);
  }

  @UseGuards(UserThrottleGuard)
  @Post('chunked/:sessionId/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Assemble chunks and run the normal upload pipeline',
    description:
      'NP-006: merakit chunk terurut lalu memanggil pipeline `uploadDirect` ' +
      'yang SAMA (validasi magic-byte, batas purpose, thumbnail ffmpeg). ' +
      'Semua chunk harus sudah diterima.',
  })
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  async completeChunkedUpload(
    @CurrentUser('sub') userId: string,
    @Param('sessionId') sessionId: string,
  ): Promise<DirectUploadResult> {
    return this.chunkedUploadService.complete(userId, sessionId);
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
