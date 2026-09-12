import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { RedisModule } from '../../redis/redis.module';
import { UploadModule } from '../upload/upload.module';
import { ShowcaseController } from './showcase.controller';
import { ShowcaseService } from './showcase.service';

/**
 * Section 3 — Showcase sebagai konten sosial + feed discover.
 *
 * UploadModule diimpor karena gambar showcase memakai alur presigned upload
 * (purpose SHOWCASE_IMAGE) dan validasinya terpusat di UploadService.
 * `ShowcaseService` di-export supaya UsersController (CRUD owner di
 * /users/me/showcase*) dan DeepLinksController (halaman share) bisa memakainya
 * tanpa memindahkan route lama.
 */
@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, UploadModule],
  controllers: [ShowcaseController],
  providers: [ShowcaseService],
  exports: [ShowcaseService],
})
export class ShowcaseModule {}
