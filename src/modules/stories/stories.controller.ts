import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { CreateStoryDto } from './dto/create-story.dto';
import {
  CreateStoryHighlightDto,
  ReplyToStoryDto,
  ReportStoryDto,
  SetStoryReactionDto,
  UpdateStoryHighlightDto,
} from './dto/story-mutations.dto';
import { StoryViewersQueryDto } from './dto/story-query.dto';
import { StoriesService } from './stories.service';
import { StoryMediaTooLargeInterceptor } from './story-media-too-large.interceptor';
import { StoryThrottle, StoryThrottleGuard } from './story-throttle.guard';
import { STORY_MEDIA_MAX_BYTES } from './stories.constants';

interface StoryMulterFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@ApiTags('stories')
@ApiBearerAuth('access-token')
@Controller('stories')
export class StoriesController {
  constructor(private readonly stories: StoriesService) {}

  @Get('tray')
  @ApiOperation({ summary: 'Story tray untuk pemilik dan profil yang disimpan viewer' })
  getTray(@CurrentUser('sub') userId: string): Promise<object> {
    return this.stories.getTray(userId);
  }

  @Get('users/:userId')
  @ApiOperation({ summary: 'Story aktif milik satu user yang dapat dilihat viewer' })
  getUserStories(
    @CurrentUser('sub') viewerId: string,
    @Param('userId', ParseIdPipe) userId: string,
  ): Promise<object> {
    return this.stories.getUserStories(viewerId, userId);
  }

  @Get('me')
  @ApiOperation({ summary: 'Story aktif milik viewer' })
  getMyStories(@CurrentUser('sub') userId: string): Promise<object> {
    return this.stories.getMyStories(userId);
  }

  @Post('media')
  @HttpCode(201)
  @UseGuards(StoryThrottleGuard)
  @StoryThrottle('media', 20, 60 * 60 * 1000)
  @UseInterceptors(
    StoryMediaTooLargeInterceptor,
    FileInterceptor('file', { limits: { fileSize: STORY_MEDIA_MAX_BYTES } }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: 'Unggah foto story ke penyimpanan disk privat' })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      required: ['mediaId', 'url'],
      properties: { mediaId: { type: 'string' }, url: { type: 'string', format: 'uri' } },
    },
  })
  uploadMedia(
    @CurrentUser('sub') userId: string,
    @UploadedFile() file?: StoryMulterFile,
  ): Promise<{ mediaId: string; url: string }> {
    if (!file)
      throw new BadRequestException({
        code: 'STORY_MEDIA_REQUIRED',
        message: 'Foto story wajib diunggah.',
      });
    return this.stories.uploadStoryMedia(userId, file.originalname, file.mimetype, file.buffer);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(StoryThrottleGuard)
  @StoryThrottle('create', 30, 60 * 60 * 1000)
  @ApiOperation({ summary: 'Buat story foto atau teks dengan privasi per-story' })
  createStory(@CurrentUser('sub') userId: string, @Body() dto: CreateStoryDto): Promise<object> {
    return this.stories.createStory(userId, dto);
  }

  @Delete(':storyId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Hapus lunak story milik sendiri' })
  async deleteStory(
    @CurrentUser('sub') userId: string,
    @Param('storyId', ParseIdPipe) storyId: string,
  ): Promise<void> {
    await this.stories.deleteStory(userId, storyId);
  }

  @Post(':storyId/views')
  @HttpCode(204)
  @UseGuards(StoryThrottleGuard)
  @StoryThrottle('view', 600, 60 * 1000)
  @ApiOperation({ summary: 'Catat view story secara idempoten' })
  async markViewed(
    @CurrentUser('sub') userId: string,
    @Param('storyId', ParseIdPipe) storyId: string,
  ): Promise<void> {
    await this.stories.markViewed(userId, storyId);
  }

  @Get(':storyId/viewers')
  @ApiOperation({ summary: 'Daftar viewer untuk pemilik story' })
  getViewers(
    @CurrentUser('sub') userId: string,
    @Param('storyId', ParseIdPipe) storyId: string,
    @Query() query: StoryViewersQueryDto,
  ): Promise<object> {
    return this.stories.getViewers(userId, storyId, query.page, query.limit);
  }

  @Put(':storyId/reaction')
  @HttpCode(204)
  @UseGuards(StoryThrottleGuard)
  @StoryThrottle('reaction', 600, 60 * 1000)
  @ApiOperation({ summary: 'Tambah atau ganti reaksi story' })
  async setReaction(
    @CurrentUser('sub') userId: string,
    @Param('storyId', ParseIdPipe) storyId: string,
    @Body() dto: SetStoryReactionDto,
  ): Promise<void> {
    await this.stories.setReaction(userId, storyId, dto);
  }

  @Delete(':storyId/reaction')
  @HttpCode(204)
  @UseGuards(StoryThrottleGuard)
  @StoryThrottle('reaction', 600, 60 * 1000)
  @ApiOperation({ summary: 'Hapus reaksi viewer dari story' })
  async removeReaction(
    @CurrentUser('sub') userId: string,
    @Param('storyId', ParseIdPipe) storyId: string,
  ): Promise<void> {
    await this.stories.removeReaction(userId, storyId);
  }

  @Post(':storyId/replies')
  @HttpCode(201)
  @ApiOperation({ summary: 'Balas story melalui pipeline moderasi chat' })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      required: ['roomId'],
      properties: { roomId: { type: 'string' } },
    },
  })
  replyToStory(
    @CurrentUser('sub') userId: string,
    @Param('storyId', ParseIdPipe) storyId: string,
    @Body() dto: ReplyToStoryDto,
  ): Promise<{ roomId: string }> {
    return this.stories.replyToStory(userId, storyId, dto.text);
  }

  @Post(':storyId/report')
  @HttpCode(201)
  @ApiOperation({ summary: 'Laporkan story yang dapat dilihat viewer' })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      required: ['reported', 'reportId'],
      properties: { reported: { type: 'boolean', enum: [true] }, reportId: { type: 'string' } },
    },
  })
  reportStory(
    @CurrentUser('sub') userId: string,
    @Param('storyId', ParseIdPipe) storyId: string,
    @Body() dto: ReportStoryDto,
  ): Promise<{ reported: true; reportId: string }> {
    return this.stories.reportStory(userId, storyId, dto);
  }

  @Get('mutes')
  @ApiOperation({ summary: 'Daftar penulis story yang dibisukan viewer' })
  getMutes(@CurrentUser('sub') userId: string): Promise<object> {
    return this.stories.listMutes(userId);
  }

  @Put('mutes/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Bisukan story seorang penulis' })
  async muteAuthor(
    @CurrentUser('sub') userId: string,
    @Param('userId', ParseIdPipe) authorPublicId: string,
  ): Promise<void> {
    await this.stories.muteAuthor(userId, authorPublicId);
  }

  @Delete('mutes/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Bunyikan kembali story seorang penulis' })
  async unmuteAuthor(
    @CurrentUser('sub') userId: string,
    @Param('userId', ParseIdPipe) authorPublicId: string,
  ): Promise<void> {
    await this.stories.unmuteAuthor(userId, authorPublicId);
  }

  @Get('audience/candidates')
  @ApiOperation({ summary: 'Daftar maksimal 500 profil yang disimpan untuk editor privasi' })
  getAudienceCandidates(@CurrentUser('sub') userId: string): Promise<object> {
    return this.stories.getAudienceCandidates(userId);
  }

  @Get('highlights/users/:userId')
  @ApiOperation({ summary: 'Highlight publik pada profil user' })
  getUserHighlights(@Param('userId', ParseIdPipe) userId: string): Promise<object> {
    return this.stories.getUserHighlights(userId);
  }

  @Post('highlights')
  @HttpCode(201)
  @ApiOperation({ summary: 'Buat highlight dengan menyalin media story' })
  createHighlight(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateStoryHighlightDto,
  ): Promise<object> {
    return this.stories.createHighlight(userId, dto);
  }

  @Patch('highlights/:highlightId')
  @ApiOperation({ summary: 'Perbarui judul atau susunan highlight milik sendiri' })
  updateHighlight(
    @CurrentUser('sub') userId: string,
    @Param('highlightId', ParseIdPipe) highlightId: string,
    @Body() dto: UpdateStoryHighlightDto,
  ): Promise<object> {
    return this.stories.updateHighlight(userId, highlightId, dto);
  }

  @Delete('highlights/:highlightId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Hapus highlight dan salinan media arsipnya' })
  async deleteHighlight(
    @CurrentUser('sub') userId: string,
    @Param('highlightId', ParseIdPipe) highlightId: string,
  ): Promise<void> {
    await this.stories.deleteHighlight(userId, highlightId);
  }
}
