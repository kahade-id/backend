import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ContentHiddenReason } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { ShowcaseService } from './showcase.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Idempotency } from '../../common/decorators/idempotency.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ShowcaseFeedQueryDto } from './dto/showcase-feed-query.dto';
import { CreateShowcaseCommentDto, UpdateShowcaseCommentDto } from './dto/showcase-comment.dto';

class SetCommentHiddenDto {
  @ApiPropertyOptional({
    enum: ContentHiddenReason,
    description: 'Kategori alasan moderasi. Wajib diisi ketika menyembunyikan komentar.',
  })
  @IsOptional()
  @IsEnum(ContentHiddenReason)
  reason?: ContentHiddenReason;
}

/**
 * Section 3 — permukaan sosial + discover untuk showcase.
 *
 * CRUD milik owner tetap di `UsersController` (`/users/me/showcase*`) supaya
 * route lama tidak berubah; controller ini menambah feed, like, komentar, dan
 * share.
 *
 * Urutan deklarasi route penting: path statis (`feed`, `comments/:id`) harus
 * dideklarasikan SEBELUM `:showcaseId`, kalau tidak "feed" akan ditangkap
 * sebagai id showcase.
 */
@ApiTags('showcase')
@Controller('showcase')
export class ShowcaseController {
  constructor(private readonly showcaseService: ShowcaseService) {}

  // ------------------------------------------------------------------
  // Discover feed
  // ------------------------------------------------------------------

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get('feed')
  @ApiOperation({
    summary: 'Discover feed for public showcase items (cursor-based)',
    description:
      'Mengembalikan item showcase PUBLIC milik akun aktif yang profilnya publik. ' +
      'Pagination memakai CURSOR (keyset), bukan offset: teruskan `nextCursor` dari ' +
      'respons sebelumnya untuk halaman berikutnya. `hasMore=false` berarti feed habis. ' +
      'Item milik user yang saling blokir dengan viewer tidak pernah muncul; viewer ' +
      'anonim melihat seluruh konten publik. Setiap item menyertakan `orderLink` yang ' +
      'sudah ter-prefill (title/description/orderValue/counterpartUsername).',
  })
  async getFeed(
    @CurrentUser('sub') viewerId: string | null,
    @Query() query: ShowcaseFeedQueryDto,
  ): Promise<object> {
    return this.showcaseService.getFeed(viewerId ?? undefined, query);
  }

  // ------------------------------------------------------------------
  // Moderasi komentar (dideklarasikan sebelum :showcaseId)
  // ------------------------------------------------------------------

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Patch('comments/:commentId')
  @Idempotency()
  @ApiOperation({ summary: 'Edit your own showcase comment' })
  async updateComment(
    @CurrentUser('sub') userId: string,
    @Param('commentId', ParseIdPipe) commentId: string,
    @Body() dto: UpdateShowcaseCommentDto,
  ): Promise<object> {
    return this.showcaseService.updateComment(userId, commentId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Delete('comments/:commentId')
  @Idempotency()
  @ApiOperation({ summary: 'Delete a showcase comment (author or showcase owner)' })
  async deleteComment(
    @CurrentUser('sub') userId: string,
    @Param('commentId', ParseIdPipe) commentId: string,
  ): Promise<{ message: string }> {
    return this.showcaseService.deleteComment(userId, commentId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post('comments/:commentId/hide')
  @Idempotency()
  @ApiOperation({
    summary: 'Hide a comment on your showcase item',
    description:
      'Hanya pemilik item showcase. `reason` wajib diisi dan menentukan kategori ' +
      'moderasi (SPAM / INAPPROPRIATE / HARASSMENT / OTHER). Komentar tersembunyi ' +
      'tidak dihitung di `commentCount` dan tidak muncul di daftar publik, tapi ' +
      'tetap terlihat oleh pemilik item agar bisa dibuka kembali.',
  })
  async hideComment(
    @CurrentUser('sub') userId: string,
    @Param('commentId', ParseIdPipe) commentId: string,
    @Body() dto: SetCommentHiddenDto,
  ): Promise<object> {
    return this.showcaseService.setCommentHidden(userId, commentId, true, dto.reason);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post('comments/:commentId/unhide')
  @Idempotency()
  @ApiOperation({ summary: 'Unhide a comment on your showcase item' })
  async unhideComment(
    @CurrentUser('sub') userId: string,
    @Param('commentId', ParseIdPipe) commentId: string,
  ): Promise<object> {
    return this.showcaseService.setCommentHidden(userId, commentId, false);
  }

  // ------------------------------------------------------------------
  // Item publik
  // ------------------------------------------------------------------

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':showcaseId/share')
  @ApiOperation({
    summary: 'Share payload for a showcase item',
    description:
      'Mengembalikan metadata untuk halaman deep link (title, description, imageUrl, ' +
      'authorUsername, shareUrl, appUrl). Item PRIVATE, item milik akun nonaktif/banned/' +
      'terhapus/profil privat, dan item yang pemiliknya saling blokir dengan viewer ' +
      'ditolak (404/403) sehingga tautan share tidak bisa dipakai mengintip konten privat.',
  })
  async getSharePayload(
    @Param('showcaseId', ParseIdPipe) showcaseId: string,
    @CurrentUser('sub') viewerId: string | null,
  ): Promise<object> {
    return this.showcaseService.getSharePayload(showcaseId, viewerId ?? undefined);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':showcaseId/comments')
  @ApiOperation({
    summary: 'List comments of a showcase item (nested replies)',
    description:
      'Komentar root dipaginasi (offset + tiebreak { id } agar halaman stabil) dan ' +
      'tiap root menyertakan `replies` satu tingkat. Komentar dari user yang saling ' +
      'blokir dengan viewer serta komentar tersembunyi disaring, kecuali untuk ' +
      'pemilik item yang tetap melihat komentar tersembunyi beserta alasannya.',
  })
  async listComments(
    @Param('showcaseId', ParseIdPipe) showcaseId: string,
    @CurrentUser('sub') viewerId: string | null,
    @Query() pagination: PaginationDto,
  ): Promise<object> {
    return this.showcaseService.listComments(
      showcaseId,
      viewerId ?? undefined,
      pagination.page ?? 1,
      pagination.limit ?? 20,
    );
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @Post(':showcaseId/comments')
  @Idempotency()
  @ApiOperation({
    summary: 'Comment on a showcase item',
    description:
      'Kirim `parentId` untuk membalas. Kedalaman dibatasi satu tingkat: membalas ' +
      'balasan ditolak dengan SHOWCASE_COMMENT_DEPTH_EXCEEDED. Interaksi dengan item ' +
      'milik user yang saling blokir ditolak 403 USER_BLOCKED.',
  })
  async addComment(
    @CurrentUser('sub') userId: string,
    @Param('showcaseId', ParseIdPipe) showcaseId: string,
    @Body() dto: CreateShowcaseCommentDto,
  ): Promise<object> {
    return this.showcaseService.addComment(userId, showcaseId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post(':showcaseId/like')
  @Idempotency()
  @ApiOperation({ summary: 'Like a showcase item' })
  async likeShowcase(
    @CurrentUser('sub') userId: string,
    @Param('showcaseId', ParseIdPipe) showcaseId: string,
  ): Promise<object> {
    return this.showcaseService.likeShowcase(userId, showcaseId);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Delete(':showcaseId/like')
  @Idempotency()
  @ApiOperation({ summary: 'Remove your like from a showcase item' })
  async unlikeShowcase(
    @CurrentUser('sub') userId: string,
    @Param('showcaseId', ParseIdPipe) showcaseId: string,
  ): Promise<object> {
    return this.showcaseService.unlikeShowcase(userId, showcaseId);
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @Get(':showcaseId')
  @ApiOperation({
    summary: 'Get a showcase item',
    description:
      'Detail satu item showcase beserta gambar, counter, dan data OrderLink siap pakai. ' +
      'Setiap pemanggilan unik menaikkan `viewCount` sekali per viewer per jam ' +
      '(dedupe Redis SET NX + atomic increment), jadi refresh tidak menggelembungkan angka.',
  })
  async getShowcase(
    @Param('showcaseId', ParseIdPipe) showcaseId: string,
    @CurrentUser('sub') viewerId: string | null,
    @Req() req: Request,
  ): Promise<object> {
    return this.showcaseService.getShowcaseDetail(showcaseId, viewerId ?? undefined, { clientIp: req.ip });
  }
}
