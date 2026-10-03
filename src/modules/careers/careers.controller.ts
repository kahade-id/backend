import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { MulterTooLargeInterceptor } from '../upload/multer-too-large.interceptor';
import { CareersService } from './careers.service';
import { SubmitApplicationDto } from './dto/submit-application.dto';

interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/** Batas CV 5 MB — ditegakkan di multer interceptor endpoint INI (bukan global). */
const CV_MULTER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Endpoint publik karir (karir.kahade.id) — tanpa auth.
 * Base path: /v1/careers (global prefix v1).
 */
@ApiTags('careers')
@Controller('careers')
export class CareersController {
  constructor(private readonly careersService: CareersService) {}

  @Public()
  @Get('postings')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Daftar lowongan aktif (ringkas, tanpa deskripsi penuh)' })
  listPostings(@Query('active') active?: string) {
    return this.careersService.listPublicPostings(active !== 'false');
  }

  @Public()
  @Get('postings/:slug')
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Detail lowongan by slug' })
  getPosting(@Param('slug') slug: string) {
    return this.careersService.getPublicPosting(slug);
  }

  @Public()
  @Get('captcha')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Minta soal captcha self-hosted (single-use, TTL 5 menit)' })
  getCaptcha() {
    return this.careersService.issueCaptcha();
  }

  @Public()
  @Post('upload-cv')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseInterceptors(
    // Urutan: error-interceptor di luar (menangkap 413 multer → kode terstruktur),
    // FileInterceptor di dalam.
    MulterTooLargeInterceptor,
    FileInterceptor('file', {
      limits: { fileSize: CV_MULTER_MAX_BYTES },
      fileFilter: (_req, file, cb) => {
        // Defense-in-depth: tolak non-PDF sedini mungkin. Validasi final
        // tetap magic-byte server-side di UploadService.uploadDirect().
        if (file.mimetype !== 'application/pdf') {
          cb(
            new BadRequestException({
              code: 'MIME_TYPE_MISMATCH',
              message: 'CV harus berupa file PDF.',
            }),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary', description: 'PDF, maks 5 MB' } },
    },
  })
  @ApiOperation({ summary: 'Upload CV (PDF ≤5 MB, one-time consume, kedaluwarsa 1 jam)' })
  async uploadCv(@UploadedFile() file: MulterFile | undefined) {
    if (!file) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'File CV wajib diunggah.',
      });
    }
    return this.careersService.uploadCv(file);
  }

  @Public()
  @Post('applications')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 3600000, limit: 5 } })
  @ApiOperation({ summary: 'Kirim lamaran (captcha + honeypot + throttle 5/jam/IP)' })
  submitApplication(@Body() dto: SubmitApplicationDto) {
    return this.careersService.submitApplication(dto);
  }

  @Public()
  @Delete('applications/:id')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Hapus lamaran sendiri via header x-deletion-token (UU PDP)' })
  deleteApplication(
    @Param('id') id: string,
    @Headers('x-deletion-token') token?: string,
  ) {
    if (!token) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Header x-deletion-token wajib diisi.',
      });
    }
    return this.careersService.deleteApplicationByToken(id, token);
  }
}
