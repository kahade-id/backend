import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { Highlight, Prisma, StoryKind, StoryReportCategory, UserAuditAction } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ChatService } from '../chat/chat.service';
import { UploadPurpose } from '../upload/dto/presigned-url.dto';
import { UploadService, isSafeFileKey } from '../upload/upload.service';
import { LocalStorageService } from '../upload/local-storage.service';
import { AuditLogService } from '../../common/services/audit-log.service';
import * as ErrorCodes from '../../common/constants/error-codes';
import { CreateStoryDto } from './dto/create-story.dto';
import {
  CreateStoryHighlightDto,
  ReportStoryDto,
  SetStoryReactionDto,
  UpdateStoryHighlightDto,
} from './dto/story-mutations.dto';
import { isStoryUnexpired, storyAudienceAllows } from './story-visibility.util';

const STORY_LIFETIME_MS = 24 * 60 * 60 * 1000;
const STORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const STORY_MEDIA_TICKET_MS = 30 * 60 * 1000;
const STORY_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const STORY_TEXT_MAX = 200;
const STORY_TAGS_MAX = 5;
const STORY_HIGHLIGHT_ITEMS_MAX = 30;
const STORY_REPORT_AUTO_HIDE_THRESHOLD = 5;
const STORY_AUTO_HIDE_MS = 24 * 60 * 60 * 1000;
const STORY_RESTORE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const AUTHOR_SELECT = {
  id: true,
  userId: true,
  username: true,
  fullName: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

type AuthorRecord = Prisma.UserGetPayload<{ select: typeof AUTHOR_SELECT }>;

type StoryRecord = {
  id: string;
  authorId: string;
  kind: StoryKind;
  mediaKey: string | null;
  textContent: string | null;
  backgroundColor: string | null;
  audience: Prisma.JsonValue;
  productTags: Prisma.JsonValue;
  priceSticker: Prisma.JsonValue | null;
  askStock: Prisma.JsonValue | null;
  createdAt: Date;
  expiresAt: Date;
  deletedAt: Date | null;
  hiddenAt: Date | null;
  hiddenUntil: Date | null;
  hiddenReason: string | null;
  author: AuthorRecord;
  views: { id: string }[];
  reactions: { emoji: string }[];
  _count: { views: number };
};

type ProductTagPosition = { productId: string; x: number; y: number };
type PublicProduct = {
  id: string;
  userId: string;
  title: string;
  priceMin: bigint | null;
  images: { imageUrl: string; fileKey: string | null }[];
};

type StoryApi = {
  id: string;
  author: { userId: string; username: string; fullName: string | null; avatarUrl: string | null };
  kind: 'image' | 'text';
  mediaUrl: string | null;
  text: string | null;
  backgroundColor: string | null;
  productTags: Array<{
    productId: string;
    title: string;
    coverUrl: string | null;
    priceAmount: number | null;
    x: number;
    y: number;
  }>;
  priceSticker: { amount: number; currency: 'IDR' } | null;
  askStock: { productId: string | null } | null;
  createdAt: string;
  expiresAt: string;
  viewed: boolean;
  viewCount: number;
  myReaction: string | null;
  audience: unknown | null;
};

function storyNotFound(): NotFoundException {
  return new NotFoundException({ code: 'STORY_NOT_FOUND', message: 'Story tidak ditemukan.' });
}

function storyNotVisible(): ForbiddenException {
  return new ForbiddenException({
    code: 'STORY_NOT_VISIBLE',
    message: 'Story ini tidak dapat dilihat.',
  });
}

function activeStoryWhere(now: Date): Prisma.StoryWhereInput {
  return {
    deletedAt: null,
    expiresAt: { gt: now },
    OR: [{ hiddenAt: null }, { hiddenUntil: { lte: now } }],
  };
}

function jsonObject(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseProductTagPositions(value: Prisma.JsonValue): ProductTagPosition[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(raw => {
    const item = jsonObject(raw as Prisma.JsonValue);
    if (
      !item ||
      typeof item.productId !== 'string' ||
      typeof item.x !== 'number' ||
      typeof item.y !== 'number' ||
      !Number.isFinite(item.x) ||
      !Number.isFinite(item.y)
    ) {
      return [];
    }
    return [{ productId: item.productId, x: item.x, y: item.y }];
  });
}

function publicAuthor(author: AuthorRecord | null | undefined) {
  if (!author) return null;
  return {
    userId: author.userId,
    username: author.username ?? author.userId,
    fullName: author.fullName,
    avatarUrl: author.avatarUrl,
  };
}

function audiencePayload(value: Prisma.JsonValue): Record<string, unknown> {
  const audience = jsonObject(value);
  if (audience?.mode === 'savers_except') {
    return {
      mode: 'savers_except',
      excludedUserIds: Array.isArray(audience.excludedUserIds)
        ? audience.excludedUserIds.filter((item): item is string => typeof item === 'string')
        : [],
    };
  }
  return { mode: 'all_savers' };
}

function toDateString(value: unknown): string | null {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString();
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return null;
}

@Injectable()
export class StoriesService {
  private readonly logger = new Logger(StoriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly localStorage: LocalStorageService,
    private readonly realtime: RealtimeService,
    private readonly redis: RedisService,
    private readonly chat: ChatService,
    private readonly auditLog: AuditLogService,
  ) {}

  async uploadStoryMedia(
    userId: string,
    fileName: string,
    contentType: string,
    fileBuffer: Buffer,
  ): Promise<{ mediaId: string; url: string }> {
    await this.assertStoryFeatureAllowed(userId);
    if (!fileBuffer || fileBuffer.length === 0) {
      throw new BadRequestException({
        code: 'STORY_MEDIA_REQUIRED',
        message: 'Foto story wajib diunggah.',
      });
    }
    if (fileBuffer.length > STORY_MEDIA_MAX_BYTES) {
      throw new PayloadTooLargeException({
        code: 'STORY_MEDIA_TOO_LARGE',
        message: 'Ukuran foto story maksimal 10 MB.',
      });
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType.toLowerCase())) {
      throw new UnsupportedMediaTypeException({
        code: 'STORY_MEDIA_TYPE',
        message: 'Format foto story harus JPEG, PNG, atau WEBP.',
      });
    }

    const uploaded = await this.uploadService.uploadDirect(
      userId,
      UploadPurpose.STORY_MEDIA,
      fileName,
      contentType.toLowerCase(),
      fileBuffer,
    );
    const now = new Date();
    const mediaId = createId();
    try {
      await this.prisma.storyMediaUpload.create({
        data: {
          id: mediaId,
          authorId: userId,
          fileKey: uploaded.fileKey,
          createdAt: now,
          expiresAt: new Date(now.getTime() + STORY_MEDIA_TICKET_MS),
        },
      });
    } catch (error) {
      await this.uploadService.cleanupFileKeys(userId, [uploaded.fileKey]).catch(() => undefined);
      throw error;
    }

    return {
      mediaId,
      // Covers the pending ticket and the full 24-hour Story lifetime.
      url: await this.uploadService.generateDownloadUrl(
        uploaded.fileKey,
        STORY_LIFETIME_MS / 1000 + 60 * 60,
      ),
    };
  }

  async createStory(userId: string, dto: CreateStoryDto): Promise<StoryApi> {
    await this.assertStoryFeatureAllowed(userId);
    const now = new Date();
    const audience = await this.validateAudience(userId, dto.audience);
    const tags = await this.validateProductTags(userId, dto.productTags);
    const askStock = await this.validateAskStockForOwner(userId, dto.askStock);
    const text = this.validateStoryText(dto.kind, dto.text);
    if (dto.kind === 'text' && !dto.backgroundColor) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Story teks wajib memiliki backgroundColor.',
      });
    }

    let mediaKey: string | null = null;
    if (dto.kind === 'image') {
      if (!dto.mediaId) {
        throw new BadRequestException({
          code: 'STORY_MEDIA_REQUIRED',
          message: 'Foto story wajib diunggah.',
        });
      }
      const ticket = await this.prisma.storyMediaUpload.findFirst({
        where: { id: dto.mediaId, authorId: userId, expiresAt: { gt: now } },
        select: { id: true, fileKey: true },
      });
      if (!ticket || !isSafeFileKey(ticket.fileKey)) {
        throw new BadRequestException({
          code: 'STORY_MEDIA_REQUIRED',
          message: 'Foto story tidak tersedia atau masa unggahnya habis.',
        });
      }
      if ((await this.uploadService.getFileSize(ticket.fileKey)) < 1) {
        throw new BadRequestException({
          code: 'STORY_MEDIA_REQUIRED',
          message: 'Foto story tidak tersedia.',
        });
      }
      mediaKey = ticket.fileKey;
    } else if (dto.mediaId) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Story teks tidak boleh menyertakan mediaId.',
      });
    }

    const story = await this.prisma.$transaction(async tx => {
      if (dto.kind === 'image') {
        const consumed = await tx.storyMediaUpload.deleteMany({
          where: { id: dto.mediaId, authorId: userId, expiresAt: { gt: now } },
        });
        if (consumed.count !== 1) {
          throw new BadRequestException({
            code: 'STORY_MEDIA_REQUIRED',
            message: 'Foto story sudah dipakai atau masa unggahnya habis.',
          });
        }
      }
      return tx.story.create({
        data: {
          authorId: userId,
          kind: dto.kind === 'image' ? StoryKind.IMAGE : StoryKind.TEXT,
          mediaKey,
          textContent: text,
          backgroundColor: dto.kind === 'text' ? dto.backgroundColor! : null,
          audience: audience as Prisma.InputJsonValue,
          productTags: tags as unknown as Prisma.InputJsonValue,
          priceSticker: dto.priceSticker
            ? ({ amount: dto.priceSticker.amount, currency: 'IDR' } as Prisma.InputJsonValue)
            : undefined,
          askStock: askStock ? (askStock as Prisma.InputJsonValue) : undefined,
          createdAt: now,
          expiresAt: new Date(now.getTime() + STORY_LIFETIME_MS),
        },
        select: { id: true },
      });
    });

    const record = await this.getStoryRecord(story.id, userId);
    const result = (await this.serializeStories([record], userId, true))[0];
    this.emitStoryCreated(record).catch(error =>
      this.logger.warn(`story.created event failed: ${String(error)}`),
    );
    return result;
  }

  async getTray(viewerId: string): Promise<object> {
    const now = new Date();
    const viewer = await this.prisma.user.findUnique({
      where: { id: viewerId },
      select: AUTHOR_SELECT,
    });
    if (!viewer)
      throw new NotFoundException({ code: ErrorCodes.USER_NOT_FOUND, message: 'User not found' });

    const [ownRows, savedProfiles] = await Promise.all([
      this.findTrayStories([viewerId], now),
      this.prisma.userSavedProfile.findMany({
        where: {
          userId: viewerId,
          savedUser: { isActive: true, isBanned: false, deletedAt: null },
        },
        select: { savedUser: { select: AUTHOR_SELECT } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const savedAuthors = savedProfiles.map(entry => entry.savedUser);
    const candidateIds = [...new Set(savedAuthors.map(author => author.id))].filter(
      id => id !== viewerId,
    );
    const otherRows = candidateIds.length ? await this.findTrayStories(candidateIds, now) : [];
    const authorMap = new Map(savedAuthors.map(author => [author.id, author]));
    const activeRows = [...ownRows, ...otherRows];

    const bannedAuthorIds = await this.activeBannedAuthorIds(
      activeRows.map(row => row.authorId),
      now,
    );
    const blockedAuthorIds = await this.blockedAuthorIds(
      viewerId,
      activeRows.map(row => row.authorId),
    );
    const availableRows = activeRows.filter(
      row => !bannedAuthorIds.has(row.authorId) && !blockedAuthorIds.has(row.authorId),
    );
    const visibleRows = availableRows.filter(
      row => row.authorId === viewerId || storyAudienceAllows(row.audience, viewer.userId),
    );
    const rowIds = visibleRows.map(row => row.id);
    const authorIds = [...new Set(visibleRows.map(row => row.authorId))];
    const [views, mutes] = await Promise.all([
      rowIds.length
        ? this.prisma.storyView.findMany({
            where: { viewerId, storyId: { in: rowIds } },
            select: { storyId: true },
          })
        : Promise.resolve([]),
      authorIds.length
        ? this.prisma.storyMute.findMany({
            where: { viewerId, authorId: { in: authorIds } },
            select: { authorId: true },
          })
        : Promise.resolve([]),
    ]);
    const viewedIds = new Set(views.map(view => view.storyId));
    const mutedIds = new Set(mutes.map(mute => mute.authorId));
    const grouped = new Map<string, StoryRecord[]>();
    for (const row of visibleRows) {
      const group = grouped.get(row.authorId) ?? [];
      group.push(row);
      grouped.set(row.authorId, group);
    }

    const makeEntry = (authorId: string) => {
      const rows = grouped.get(authorId) ?? [];
      if (rows.length === 0) return null;
      const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const author = authorId === viewerId ? viewer : (authorMap.get(authorId) ?? sorted[0].author);
      return {
        author: publicAuthor(author),
        storyCount: sorted.length,
        latestAt: sorted[sorted.length - 1].createdAt.toISOString(),
        hasUnseen: authorId === viewerId ? false : sorted.some(row => !viewedIds.has(row.id)),
        muted: authorId === viewerId ? false : mutedIds.has(authorId),
      };
    };

    const own = makeEntry(viewerId);
    const others = candidateIds
      .map(authorId => makeEntry(authorId))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    return { own, others };
  }

  async getUserStories(viewerId: string, authorPublicId: string): Promise<object> {
    const author = await this.prisma.user.findUnique({
      where: { userId: authorPublicId },
      select: { ...AUTHOR_SELECT, isActive: true, isBanned: true, deletedAt: true },
    });
    if (!author || !author.isActive || author.isBanned || author.deletedAt) throw storyNotFound();
    const owner = author.id === viewerId;
    if (!owner) {
      if (await this.isBlocked(viewerId, author.id)) throw storyNotVisible();
      const saved = await this.prisma.userSavedProfile.findUnique({
        where: { userId_savedUserId: { userId: viewerId, savedUserId: author.id } },
        select: { id: true },
      });
      if (!saved) throw storyNotVisible();
    }

    const now = new Date();
    if ((await this.activeBannedAuthorIds([author.id], now)).has(author.id)) {
      return { author: publicAuthor(author), stories: [] };
    }
    const rows = await this.findTrayStories([author.id], now, viewerId);
    const viewerPublicId = owner ? '' : await this.viewerPublicId(viewerId);
    const visibleRows = owner
      ? rows
      : rows.filter(row => storyAudienceAllows(row.audience, viewerPublicId));
    if (!owner && rows.length > 0 && visibleRows.length === 0) throw storyNotVisible();
    return {
      author: publicAuthor(author),
      // Only /me and POST /stories expose privacy settings; this path always
      // returns the public per-viewer Story shape, even when owner opens it.
      stories: await this.serializeStories(visibleRows, viewerId, false),
    };
  }

  async getMyStories(viewerId: string): Promise<{ stories: StoryApi[] }> {
    const now = new Date();
    const activeBan = (await this.activeBannedAuthorIds([viewerId], now)).has(viewerId);
    if (activeBan) return { stories: [] };
    const rows = await this.findTrayStories([viewerId], now, viewerId);
    return { stories: await this.serializeStories(rows, viewerId, true) };
  }

  async deleteStory(userId: string, storyId: string): Promise<void> {
    const story = await this.prisma.story.findFirst({
      where: { id: storyId, authorId: userId, deletedAt: null },
      include: { author: { select: AUTHOR_SELECT } },
    });
    if (!story) throw storyNotFound();
    await this.prisma.story.update({ where: { id: storyId }, data: { deletedAt: new Date() } });
    await this.emitStoryVisibilityEvent(story, 'story.deleted');
  }

  async markViewed(viewerId: string, storyId: string): Promise<void> {
    const story = await this.getAccessibleStory(viewerId, storyId);
    if (story.authorId === viewerId) return;
    const created = await this.prisma.storyView.createMany({
      data: [{ storyId, viewerId }],
      skipDuplicates: true,
    });
    if (created.count === 0) return;

    const shouldEmit = await this.redis
      .setNx(`stories:view-event:${storyId}`, '1', 5)
      .catch(() => false);
    if (shouldEmit) {
      const viewCount = await this.prisma.storyView.count({ where: { storyId } });
      this.realtime.emitToUser(story.authorId, 'story.viewers.updated', { storyId, viewCount });
    }
  }

  async getViewers(
    viewerId: string,
    storyId: string,
    page: number,
    limit: number,
  ): Promise<object> {
    const story = await this.prisma.story.findFirst({
      where: { id: storyId, authorId: viewerId },
      select: { id: true, deletedAt: true, expiresAt: true, hiddenAt: true, hiddenUntil: true },
    });
    if (!story)
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Hanya pemilik story yang dapat melihat daftar viewer.',
      });
    const now = new Date();
    if (
      story.deletedAt ||
      story.expiresAt <= now ||
      (story.hiddenAt && (!story.hiddenUntil || story.hiddenUntil > now))
    ) {
      throw storyNotFound();
    }

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const [total, rows] = await Promise.all([
      this.prisma.storyView.count({ where: { storyId } }),
      this.prisma.storyView.findMany({
        where: { storyId },
        orderBy: [{ viewedAt: 'desc' }, { id: 'desc' }],
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        select: {
          viewerId: true,
          viewedAt: true,
          viewer: { select: AUTHOR_SELECT },
        },
      }),
    ]);
    const reactions = rows.length
      ? await this.prisma.storyReaction.findMany({
          where: { storyId, viewerId: { in: rows.map(row => row.viewerId) } },
          select: { viewerId: true, emoji: true },
        })
      : [];
    const reactionByViewer = new Map(
      reactions.map(reaction => [reaction.viewerId, reaction.emoji]),
    );
    return {
      viewers: rows.map(row => ({
        user: publicAuthor(row.viewer),
        viewedAt: row.viewedAt.toISOString(),
        reaction: reactionByViewer.get(row.viewerId) ?? null,
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async setReaction(viewerId: string, storyId: string, dto: SetStoryReactionDto): Promise<void> {
    const allowed = ['❤️', '😂', '😮', '😢', '👏', '🔥'];
    if (!allowed.includes(dto.emoji)) {
      throw new BadRequestException({
        code: 'STORY_REACTION_INVALID',
        message: 'Emoji reaksi story tidak valid.',
      });
    }
    await this.getAccessibleStory(viewerId, storyId);
    await this.prisma.storyReaction.upsert({
      where: { storyId_viewerId: { storyId, viewerId } },
      create: { storyId, viewerId, emoji: dto.emoji },
      update: { emoji: dto.emoji },
    });
  }

  async removeReaction(viewerId: string, storyId: string): Promise<void> {
    await this.getAccessibleStory(viewerId, storyId);
    await this.prisma.storyReaction.deleteMany({ where: { storyId, viewerId } });
  }

  async replyToStory(
    viewerId: string,
    storyId: string,
    rawText: string,
  ): Promise<{ roomId: string }> {
    const text = rawText.trim();
    if (!text) {
      throw new BadRequestException({
        code: 'STORY_REPLY_EMPTY',
        message: 'Balasan story tidak boleh kosong.',
      });
    }
    if (text.length > STORY_TEXT_MAX) {
      throw new BadRequestException({
        code: 'STORY_REPLY_TOO_LONG',
        message: 'Balasan story maksimal 200 karakter.',
      });
    }
    const story = await this.getAccessibleStory(viewerId, storyId);
    if (story.authorId === viewerId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Pemilik story tidak dapat membalas story sendiri.',
      });
    }
    const result = (await this.chat.createInquiry(
      viewerId,
      { counterpartId: story.authorId, subject: 'Balasan story', message: text },
      story.id,
    )) as { room: { id: string } };
    const roomId = result.room.id;
    this.realtime.emitToUser(story.authorId, 'story.reply.received', { storyId, roomId });
    return { roomId };
  }

  async reportStory(
    viewerId: string,
    storyId: string,
    dto: ReportStoryDto,
  ): Promise<{ reported: true; reportId: string }> {
    const story = await this.getAccessibleStory(viewerId, storyId);
    if (story.authorId === viewerId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Anda tidak dapat melaporkan story sendiri.',
      });
    }
    const prior = await this.prisma.storyReport.findUnique({
      where: { storyId_reporterId: { storyId, reporterId: viewerId } },
      select: { id: true },
    });
    if (prior)
      throw new ConflictException({
        code: 'STORY_ALREADY_REPORTED',
        message: 'Story ini sudah pernah dilaporkan.',
      });

    const snapshot = {
      id: story.id,
      author: publicAuthor(story.author),
      kind: story.kind === StoryKind.IMAGE ? 'image' : 'text',
      mediaKey: story.mediaKey,
      text: story.textContent,
      backgroundColor: story.backgroundColor,
      audience: audiencePayload(story.audience),
      productTags: parseProductTagPositions(story.productTags),
      priceSticker: story.priceSticker,
      askStock: story.askStock,
      createdAt: story.createdAt.toISOString(),
      expiresAt: story.expiresAt.toISOString(),
    };
    let report: { id: string };
    try {
      report = await this.prisma.storyReport.create({
        data: {
          storyId,
          authorId: story.authorId,
          reporterId: viewerId,
          category: dto.category.toUpperCase() as StoryReportCategory,
          note: dto.note?.trim() || null,
          storySnapshot: snapshot as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({
          code: 'STORY_ALREADY_REPORTED',
          message: 'Story ini sudah pernah dilaporkan.',
        });
      }
      throw error;
    }
    this.auditLog.logUserAction({
      userId: viewerId,
      action: UserAuditAction.STORY_REPORTED,
      entityType: 'StoryReport',
      entityId: report.id,
      description: 'User reported a Story',
      after: { storyId, category: dto.category },
    });

    const reportCount = await this.prisma.storyReport.count({ where: { storyId } });
    if (reportCount >= STORY_REPORT_AUTO_HIDE_THRESHOLD) {
      const now = new Date();
      const hidden = await this.prisma.story.updateMany({
        where: { id: storyId, deletedAt: null, hiddenAt: null },
        data: {
          hiddenAt: now,
          hiddenUntil: new Date(now.getTime() + STORY_AUTO_HIDE_MS),
          hiddenReason: 'AUTO_REPORT_THRESHOLD',
        },
      });
      if (hidden.count > 0) await this.emitStoryVisibilityEvent(story, 'story.deleted');
    }
    return { reported: true, reportId: report.id };
  }

  async listMutes(viewerId: string): Promise<object> {
    const rows = await this.prisma.storyMute.findMany({
      where: { viewerId, author: { isActive: true, isBanned: false, deletedAt: null } },
      orderBy: { createdAt: 'desc' },
      select: { author: { select: AUTHOR_SELECT } },
    });
    return { mutes: rows.map(row => publicAuthor(row.author)) };
  }

  async muteAuthor(viewerId: string, authorPublicId: string): Promise<void> {
    const author = await this.prisma.user.findUnique({
      where: { userId: authorPublicId },
      select: { id: true },
    });
    if (!author || author.id === viewerId) throw storyNotFound();
    await this.prisma.storyMute.upsert({
      where: { viewerId_authorId: { viewerId, authorId: author.id } },
      create: { viewerId, authorId: author.id },
      update: {},
    });
    this.realtime.emitToUser(viewerId, 'story.mute.changed', {
      userId: authorPublicId,
      muted: true,
    });
  }

  async unmuteAuthor(viewerId: string, authorPublicId: string): Promise<void> {
    const author = await this.prisma.user.findUnique({
      where: { userId: authorPublicId },
      select: { id: true },
    });
    if (!author || author.id === viewerId) return;
    await this.prisma.storyMute.deleteMany({ where: { viewerId, authorId: author.id } });
    this.realtime.emitToUser(viewerId, 'story.mute.changed', {
      userId: authorPublicId,
      muted: false,
    });
  }

  async getAudienceCandidates(viewerId: string): Promise<object> {
    const rows = await this.prisma.userSavedProfile.findMany({
      where: { userId: viewerId, savedUser: { isActive: true, isBanned: false, deletedAt: null } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { savedUser: { select: AUTHOR_SELECT } },
    });
    return { users: rows.map(row => publicAuthor(row.savedUser)) };
  }

  async getUserHighlights(authorPublicId: string): Promise<object> {
    const author = await this.prisma.user.findUnique({
      where: { userId: authorPublicId },
      select: { id: true, isActive: true, isBanned: true, deletedAt: true },
    });
    if (!author || !author.isActive || author.isBanned || author.deletedAt)
      throw new NotFoundException({ code: 'STORY_NOT_FOUND', message: 'Profil tidak ditemukan.' });
    const rows = await this.prisma.highlight.findMany({
      where: { userId: author.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { highlights: await Promise.all(rows.map(row => this.serializeHighlight(row))) };
  }

  async createHighlight(userId: string, dto: CreateStoryHighlightDto): Promise<object> {
    const title = this.validateHighlightTitle(dto.title);
    const storyIds = this.validateHighlightStoryIds(dto.storyIds);
    const rows = await this.getOwnedActiveStories(userId, storyIds);
    const copiedKeys: string[] = [];
    try {
      const snapshots = await this.createHighlightSnapshots(userId, rows, copiedKeys);
      const highlight = await this.prisma.highlight.create({
        data: {
          userId,
          title,
          coverStoryId: storyIds[0] ?? null,
          storyIds,
          stories: snapshots as Prisma.InputJsonValue,
        },
      });
      return this.serializeHighlight(highlight);
    } catch (error) {
      await this.uploadService.cleanupFileKeys(userId, copiedKeys).catch(() => undefined);
      throw error;
    }
  }

  async updateHighlight(
    userId: string,
    highlightId: string,
    dto: UpdateStoryHighlightDto,
  ): Promise<object> {
    const current = await this.prisma.highlight.findFirst({ where: { id: highlightId, userId } });
    if (!current) throw storyNotFound();
    if (dto.title === undefined && dto.storyIds === undefined) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Kirim title dan/atau storyIds.',
      });
    }
    const title = dto.title === undefined ? current.title : this.validateHighlightTitle(dto.title);
    let storyIds = current.storyIds;
    let snapshots: unknown[] = Array.isArray(current.stories) ? [...current.stories] : [];
    const oldKeys = this.highlightMediaKeys(snapshots);
    const newKeys: string[] = [];

    if (dto.storyIds !== undefined) {
      storyIds = this.validateHighlightStoryIds(dto.storyIds);
      const currentSnapshots = new Map(
        snapshots.flatMap(raw => {
          const item = jsonObject(raw as Prisma.JsonValue);
          return item && typeof item.id === 'string' ? [[item.id, item] as const] : [];
        }),
      );
      const needsCopy = storyIds.filter(id => !currentSnapshots.has(id));
      const liveRows = needsCopy.length ? await this.getOwnedActiveStories(userId, needsCopy) : [];
      const newSnapshots = new Map<string, Record<string, unknown>>();
      if (liveRows.length) {
        const copies = await this.createHighlightSnapshots(userId, liveRows, newKeys);
        for (const raw of copies) {
          const item = jsonObject(raw as Prisma.JsonValue);
          if (item && typeof item.id === 'string') newSnapshots.set(item.id, item);
        }
      }
      snapshots = storyIds.map(id => {
        const prior = currentSnapshots.get(id);
        if (prior) return prior;
        const added = newSnapshots.get(id);
        if (!added) throw storyNotFound();
        return added;
      });
    }

    let updated: Highlight;
    try {
      updated = await this.prisma.highlight.update({
        where: { id: highlightId },
        data: {
          title,
          storyIds,
          coverStoryId: storyIds[0] ?? null,
          stories: snapshots as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      await this.uploadService.cleanupFileKeys(userId, newKeys).catch(() => undefined);
      throw error;
    }
    const retained = new Set(this.highlightMediaKeys(snapshots));
    const obsolete = oldKeys.filter(key => !retained.has(key));
    if (obsolete.length) {
      await this.uploadService
        .cleanupFileKeys(userId, obsolete)
        .then(result => {
          if (result.errors.length > 0) {
            this.logger.error(
              `Gagal membersihkan ${result.errors.length} salinan highlight lama setelah update`,
            );
          }
        })
        .catch(error => {
          this.logger.warn(`Gagal membersihkan salinan highlight lama: ${String(error)}`);
        });
    }
    return this.serializeHighlight(updated);
  }

  async deleteHighlight(userId: string, highlightId: string): Promise<void> {
    const highlight = await this.prisma.highlight.findFirst({ where: { id: highlightId, userId } });
    if (!highlight) throw storyNotFound();
    const keys = this.highlightMediaKeys(Array.isArray(highlight.stories) ? highlight.stories : []);
    if (keys.length) {
      const cleanup = await this.uploadService.cleanupFileKeys(userId, keys);
      if (cleanup.errors.length > 0) {
        throw new ServiceUnavailableException({
          code: ErrorCodes.UPLOAD_STORAGE_UNAVAILABLE,
          message: 'Media sorotan belum dapat dihapus. Silakan coba lagi.',
        });
      }
    }
    await this.prisma.highlight.delete({ where: { id: highlightId } });
  }

  /** Used by the 5–15 minute retention worker and by the scheduler tests. */
  async cleanupExpiredAndRetained(
    now = new Date(),
    batchSize = 250,
  ): Promise<{ expired: number; deleted: number; mediaTickets: number }> {
    const expiredRows = await this.prisma.story.findMany({
      where: { expiresAt: { lte: now }, expiryNotifiedAt: null, deletedAt: null },
      take: batchSize,
      orderBy: { expiresAt: 'asc' },
      include: { author: { select: AUTHOR_SELECT } },
    });
    let expired = 0;
    for (const row of expiredRows) {
      const claimed = await this.prisma.story.updateMany({
        where: {
          id: row.id,
          expiryNotifiedAt: null,
          deletedAt: null,
          expiresAt: { lte: now },
        },
        data: { expiryNotifiedAt: now },
      });
      if (claimed.count === 1) {
        expired++;
        await this.emitStoryVisibilityEvent(row, 'story.expired');
      }
    }

    const pendingTickets = await this.prisma.storyMediaUpload.findMany({
      where: { expiresAt: { lte: now } },
      take: batchSize,
      select: { id: true, authorId: true, fileKey: true },
    });
    let mediaTickets = 0;
    for (const row of pendingTickets) {
      const cleanup = await this.uploadService.cleanupFileKeys(row.authorId, [row.fileKey]);
      if (cleanup.errors.length > 0) {
        // Keep the expired ticket as a retry record. It can no longer be used
        // to create a Story because its expiresAt has passed.
        this.logger.warn(`Expired Story media cleanup will retry for ticket=${row.id}`);
        continue;
      }
      const removed = await this.prisma.storyMediaUpload.deleteMany({ where: { id: row.id } });
      mediaTickets += removed.count;
    }

    const regularCutoff = new Date(now.getTime() - STORY_RETENTION_MS);
    const deletedCutoff = new Date(now.getTime() - STORY_RETENTION_MS);
    const retainedRows = await this.prisma.story.findMany({
      where: {
        OR: [
          { deletedAt: null, expiresAt: { lte: regularCutoff } },
          { deletedAt: { lte: deletedCutoff } },
        ],
      },
      take: batchSize,
      orderBy: { expiresAt: 'asc' },
      select: { id: true, authorId: true, mediaKey: true },
    });
    let deleted = 0;
    for (const row of retainedRows) {
      if (row.mediaKey) {
        const cleanup = await this.uploadService.cleanupFileKeys(row.authorId, [row.mediaKey]);
        if (cleanup.errors.length > 0) {
          // Keep the row hidden but intact so the next retention run can retry
          // media deletion instead of orphaning a private file on disk.
          this.logger.warn(`Expired Story hard-delete will retry media cleanup for story=${row.id}`);
          continue;
        }
      }
      const result = await this.prisma.story.deleteMany({ where: { id: row.id } });
      if (result.count > 0) deleted++;
    }

    // Expired temporary mutes need no cleanup: their relation is user-managed.
    return { expired, deleted, mediaTickets };
  }

  /** Admin-only hard delete; StoryReport snapshots intentionally remain. */
  async adminDeleteStory(
    storyId: string,
  ): Promise<{ storyId: string; authorId: string; mediaKey: string | null }> {
    const story = await this.prisma.story.findUnique({
      where: { id: storyId },
      include: { author: { select: AUTHOR_SELECT } },
    });
    if (!story) throw storyNotFound();
    const recipients = await this.storyVisibilityRecipientIds(story);
    // Hide first so a storage failure cannot leave a supposedly deleted Story
    // visible. The row acts as a retry record until its private media is gone.
    if (!story.deletedAt) {
      await this.prisma.story.update({ where: { id: storyId }, data: { deletedAt: new Date() } });
    }
    if (story.mediaKey) {
      const cleanup = await this.uploadService.cleanupFileKeys(story.authorId, [story.mediaKey]);
      if (cleanup.errors.length > 0) {
        throw new ServiceUnavailableException({
          code: ErrorCodes.UPLOAD_STORAGE_UNAVAILABLE,
          message: 'Media Story belum dapat dihapus. Silakan coba lagi.',
        });
      }
    }
    await this.prisma.story.delete({ where: { id: storyId } });
    this.emitStoryVisibilityToRecipients(story, 'story.deleted', recipients);
    return { storyId, authorId: story.authorId, mediaKey: story.mediaKey };
  }

  async adminHideStory(
    storyId: string,
    adminId: string,
    reason: string,
    hiddenUntil: Date | null,
  ): Promise<void> {
    const story = await this.prisma.story.findUnique({
      where: { id: storyId },
      include: { author: { select: AUTHOR_SELECT } },
    });
    if (!story) throw storyNotFound();
    await this.prisma.story.update({
      where: { id: storyId },
      data: { hiddenAt: new Date(), hiddenUntil, hiddenReason: reason, hiddenByAdminId: adminId },
    });
    await this.emitStoryVisibilityEvent(story, 'story.deleted');
  }

  async adminRestoreStory(storyId: string): Promise<void> {
    const story = await this.prisma.story.findUnique({ where: { id: storyId } });
    if (
      !story ||
      !story.hiddenAt ||
      Date.now() - story.hiddenAt.getTime() > STORY_RESTORE_WINDOW_MS
    )
      throw storyNotFound();
    await this.prisma.story.update({
      where: { id: storyId },
      data: { hiddenAt: null, hiddenUntil: null, hiddenReason: null, hiddenByAdminId: null },
    });
  }

  async adminBanStoryFeature(
    userPublicId: string,
    adminId: string,
    reason: string,
    durationDays?: number | null,
  ): Promise<{ userId: string; bannedUntil: Date | null }> {
    const user = await this.prisma.user.findUnique({
      where: { userId: userPublicId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    const bannedUntil = durationDays
      ? new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000)
      : null;
    await this.prisma.storyFeatureBan.upsert({
      where: { userId: user.id },
      create: { userId: user.id, reason, bannedUntil, isActive: true, bannedByAdminId: adminId },
      update: { reason, bannedUntil, isActive: true, bannedByAdminId: adminId },
    });
    const stories = await this.prisma.story.findMany({
      where: { authorId: user.id, ...activeStoryWhere(new Date()), hiddenAt: null },
      include: { author: { select: AUTHOR_SELECT } },
    });
    await this.prisma.story.updateMany({
      where: { authorId: user.id, deletedAt: null, expiresAt: { gt: new Date() }, hiddenAt: null },
      data: {
        hiddenAt: new Date(),
        hiddenUntil: bannedUntil,
        hiddenReason: 'FEATURE_BAN',
        hiddenByAdminId: adminId,
      },
    });
    for (const story of stories) await this.emitStoryVisibilityEvent(story, 'story.deleted');
    return { userId: user.id, bannedUntil };
  }

  async adminUnbanStoryFeature(userPublicId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { userId: userPublicId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    await this.prisma.storyFeatureBan.updateMany({
      where: { userId: user.id },
      data: { isActive: false },
    });
    await this.prisma.story.updateMany({
      where: { authorId: user.id, hiddenReason: 'FEATURE_BAN' },
      data: { hiddenAt: null, hiddenUntil: null, hiddenReason: null, hiddenByAdminId: null },
    });
  }

  async getAdminStoryRecord(storyId: string): Promise<unknown> {
    const story = await this.prisma.story.findUnique({
      where: { id: storyId },
      include: {
        author: { select: { ...AUTHOR_SELECT, isActive: true, isBanned: true, deletedAt: true } },
        _count: { select: { views: true, reactions: true } },
      },
    });
    if (!story) throw storyNotFound();
    const mediaUrl = story.mediaKey
      ? await this.uploadService.generateDownloadUrl(story.mediaKey, 300)
      : null;
    return {
      id: story.id,
      author: publicAuthor(story.author),
      kind: story.kind === StoryKind.IMAGE ? 'image' : 'text',
      mediaUrl,
      text: story.textContent,
      backgroundColor: story.backgroundColor,
      productTags: await this.serializeProductTags(
        story.authorId,
        parseProductTagPositions(story.productTags),
      ),
      priceSticker: this.serializePriceSticker(story.priceSticker),
      askStock: this.serializeAskStock(story.askStock),
      audience: audiencePayload(story.audience),
      createdAt: story.createdAt.toISOString(),
      expiresAt: story.expiresAt.toISOString(),
      deletedAt: story.deletedAt?.toISOString() ?? null,
      hiddenAt: story.hiddenAt?.toISOString() ?? null,
      hiddenUntil: story.hiddenUntil?.toISOString() ?? null,
      hiddenReason: story.hiddenReason,
      viewCount: story._count.views,
      reactionCount: story._count.reactions,
    };
  }

  async getAdminStoryViewers(storyId: string, page: number, limit: number): Promise<object> {
    const story = await this.prisma.story.findUnique({
      where: { id: storyId },
      select: { id: true },
    });
    if (!story) throw storyNotFound();
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const [total, rows] = await Promise.all([
      this.prisma.storyView.count({ where: { storyId } }),
      this.prisma.storyView.findMany({
        where: { storyId },
        orderBy: { viewedAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
        include: { viewer: { select: AUTHOR_SELECT } },
      }),
    ]);
    const reactions = rows.length
      ? await this.prisma.storyReaction.findMany({
          where: { storyId, viewerId: { in: rows.map(row => row.viewerId) } },
          select: { viewerId: true, emoji: true },
        })
      : [];
    const byViewer = new Map(reactions.map(row => [row.viewerId, row.emoji]));
    return {
      viewers: rows.map(row => ({
        user: publicAuthor(row.viewer),
        viewedAt: row.viewedAt.toISOString(),
        reaction: byViewer.get(row.viewerId) ?? null,
      })),
      total,
      page: safePage,
      limit: safeLimit,
    };
  }

  async getAdminStoryReplies(storyId: string): Promise<object> {
    const openReport = await this.prisma.storyReport.count({
      where: { storyId, status: { in: ['OPEN', 'IN_REVIEW'] } },
    });
    if (!openReport)
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Riwayat balasan hanya tersedia selama ada laporan terbuka.',
      });
    const seeds = await this.prisma.chatMessage.findMany({
      where: { storyId },
      select: { roomId: true },
    });
    const roomIds = [...new Set(seeds.map(message => message.roomId))];
    if (!roomIds.length) return { rooms: [] };
    const rooms = await this.prisma.chatRoom.findMany({
      where: { id: { in: roomIds } },
      take: 100,
      select: {
        id: true,
        type: true,
        subject: true,
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: {
            id: true,
            storyId: true,
            sender: { select: { userId: true, username: true, fullName: true } },
            messageType: true,
            content: true,
            isDeleted: true,
            createdAt: true,
          },
        },
      },
    });
    return {
      rooms: rooms.map(room => ({
        roomId: room.id,
        type: room.type,
        subject: room.subject,
        messages: room.messages.map(message => ({
          id: message.id,
          storyId: message.storyId,
          sender: message.sender,
          messageType: message.messageType,
          text: message.isDeleted ? null : message.content,
          deleted: message.isDeleted,
          createdAt: message.createdAt.toISOString(),
        })),
      })),
    };
  }

  private async assertStoryFeatureAllowed(userId: string): Promise<void> {
    const [user, ban] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, isActive: true, isBanned: true, deletedAt: true },
      }),
      this.prisma.storyFeatureBan.findUnique({
        where: { userId },
        select: { isActive: true, bannedUntil: true },
      }),
    ]);
    if (!user || !user.isActive || user.isBanned || user.deletedAt) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Akun tidak dapat menggunakan fitur story.',
      });
    }
    if (ban?.isActive && (!ban.bannedUntil || ban.bannedUntil.getTime() > Date.now())) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Akun dibatasi dari fitur story.',
      });
    }
  }

  private validateStoryText(kind: 'image' | 'text', input?: string): string | null {
    const text = input?.trim() ?? '';
    if (text.length > STORY_TEXT_MAX) {
      throw new BadRequestException({
        code: 'STORY_TEXT_TOO_LONG',
        message: 'Teks story maksimal 200 karakter.',
      });
    }
    if (kind === 'text' && !text) {
      throw new BadRequestException({
        code: 'STORY_TEXT_REQUIRED',
        message: 'Teks story wajib diisi.',
      });
    }
    return text || null;
  }

  private async validateAudience(
    userId: string,
    input: CreateStoryDto['audience'],
  ): Promise<Record<string, unknown>> {
    if (!input || !['all_savers', 'savers_except'].includes(input.mode)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Audience story tidak valid.',
      });
    }
    const excluded = input.mode === 'savers_except' ? (input.excludedUserIds ?? []) : [];
    if (input.mode === 'all_savers' && input.excludedUserIds?.length) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'excludedUserIds hanya untuk mode savers_except.',
      });
    }
    if (excluded.length > 500) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Maksimal 500 user dapat dikecualikan.',
      });
    }
    if (new Set(excluded).size !== excluded.length) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Daftar excludedUserIds tidak boleh duplikat.',
      });
    }
    if (excluded.length) {
      const allowedUsers = await this.prisma.user.findMany({
        where: { userId: { in: excluded }, isActive: true, isBanned: false, deletedAt: null },
        select: { userId: true },
      });
      if (allowedUsers.length !== excluded.length) {
        throw new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: 'Semua excludedUserIds harus merupakan profil aktif.',
        });
      }
    }
    return input.mode === 'savers_except'
      ? { mode: 'savers_except', excludedUserIds: excluded }
      : { mode: 'all_savers' };
  }

  private async validateProductTags(
    userId: string,
    tags: CreateStoryDto['productTags'],
  ): Promise<ProductTagPosition[]> {
    if (tags.length > STORY_TAGS_MAX) {
      throw new BadRequestException({
        code: 'STORY_TAGS_LIMIT',
        message: 'Maksimal 5 produk dapat ditandai pada satu story.',
      });
    }
    const ids = tags.map(tag => tag.productId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException({
        code: 'STORY_PRODUCT_TAG_INVALID',
        message: 'Produk yang sama tidak boleh ditandai dua kali.',
      });
    }
    if (!ids.length) return [];
    const owned = await this.prisma.userShowcase.findMany({
      where: { id: { in: ids }, userId, isActive: true, visibility: 'PUBLIC', deletedAt: null },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new BadRequestException({
        code: 'STORY_PRODUCT_TAG_INVALID',
        message: 'Produk harus milik Anda dan tampil di etalase.',
      });
    }
    return tags.map(tag => ({ productId: tag.productId, x: tag.x, y: tag.y }));
  }

  private async findTrayStories(
    authorIds: string[],
    now: Date,
    viewerId?: string,
  ): Promise<StoryRecord[]> {
    if (!authorIds.length) return [];
    const rows = await this.prisma.story.findMany({
      where: { ...activeStoryWhere(now), authorId: { in: authorIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        author: { select: AUTHOR_SELECT },
        views: viewerId
          ? { where: { viewerId }, select: { id: true } }
          : { where: { viewerId: '__story_no_viewer__' }, select: { id: true } },
        reactions: viewerId
          ? { where: { viewerId }, select: { emoji: true } }
          : { where: { viewerId: '__story_no_viewer__' }, select: { emoji: true } },
        _count: { select: { views: true } },
      },
    });
    return rows as unknown as StoryRecord[];
  }

  private async getStoryRecord(storyId: string, viewerId: string): Promise<StoryRecord> {
    const row = await this.prisma.story.findUnique({
      where: { id: storyId },
      include: {
        author: { select: AUTHOR_SELECT },
        views: { where: { viewerId }, select: { id: true } },
        reactions: { where: { viewerId }, select: { emoji: true } },
        _count: { select: { views: true } },
      },
    });
    if (!row) throw storyNotFound();
    return row as unknown as StoryRecord;
  }

  private async getAccessibleStory(viewerId: string, storyId: string): Promise<StoryRecord> {
    const now = new Date();
    const row = await this.prisma.story.findFirst({
      where: { id: storyId, ...activeStoryWhere(now) },
      include: {
        author: { select: { ...AUTHOR_SELECT, isActive: true, isBanned: true, deletedAt: true } },
        views: { where: { viewerId }, select: { id: true } },
        reactions: { where: { viewerId }, select: { emoji: true } },
        _count: { select: { views: true } },
      },
    });
    if (!row) throw storyNotFound();
    const story = row as unknown as StoryRecord;
    const authorAvailability = story.author as AuthorRecord & {
      isActive?: boolean;
      isBanned?: boolean;
      deletedAt?: Date | null;
    };
    if (
      authorAvailability.isActive === false ||
      authorAvailability.isBanned ||
      authorAvailability.deletedAt ||
      !isStoryUnexpired(story.expiresAt, now)
    )
      throw storyNotFound();
    if (story.authorId === viewerId) return story;
    const [viewer, blocked, saved, banned] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: viewerId }, select: { userId: true } }),
      this.isBlocked(viewerId, story.authorId),
      this.prisma.userSavedProfile.findUnique({
        where: { userId_savedUserId: { userId: viewerId, savedUserId: story.authorId } },
        select: { id: true },
      }),
      this.activeBannedAuthorIds([story.authorId], now),
    ]);
    if (!viewer || blocked || !saved || banned.has(story.authorId)) throw storyNotFound();
    if (!storyAudienceAllows(story.audience, viewer.userId)) throw storyNotFound();
    return story;
  }

  private async serializeStories(
    rows: StoryRecord[],
    viewerId: string,
    includeAudience: boolean,
  ): Promise<StoryApi[]> {
    if (!rows.length) return [];
    const products = await this.buildProductMap(
      rows.map(row => ({ authorId: row.authorId, productTags: row.productTags })),
    );
    return Promise.all(
      rows.map(async row => this.serializeStory(row, viewerId, includeAudience, products)),
    );
  }

  private async serializeStory(
    row: StoryRecord,
    viewerId: string,
    includeAudience: boolean,
    products: Map<string, PublicProduct>,
  ): Promise<StoryApi> {
    const mediaUrl = row.mediaKey
      ? await this.uploadService.generateDownloadUrl(row.mediaKey, STORY_LIFETIME_MS / 1000)
      : null;
    const priceSticker = this.serializePriceSticker(row.priceSticker);
    const askStock = this.serializeAskStock(row.askStock);
    const productTags = await Promise.all(
      parseProductTagPositions(row.productTags).map(async tag => {
        const product = products.get(`${row.authorId}:${tag.productId}`);
        if (!product) return null;
        return {
          productId: product.id,
          title: product.title,
          coverUrl: await this.productCoverUrl(product),
          priceAmount: product.priceMin === null ? null : Number(product.priceMin),
          x: tag.x,
          y: tag.y,
        };
      }),
    );
    return {
      id: row.id,
      author: publicAuthor(row.author)!,
      kind: row.kind === StoryKind.IMAGE ? 'image' : 'text',
      mediaUrl,
      text: row.textContent,
      backgroundColor: row.backgroundColor,
      productTags: productTags.filter((tag): tag is NonNullable<typeof tag> => tag !== null),
      priceSticker,
      askStock,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      viewed: row.views.length > 0,
      viewCount: row.authorId === viewerId ? row._count.views : 0,
      myReaction: row.reactions[0]?.emoji ?? null,
      audience: includeAudience ? audiencePayload(row.audience) : null,
    };
  }

  private serializePriceSticker(value: Prisma.JsonValue | null): StoryApi['priceSticker'] {
    const sticker = jsonObject(value);
    const amount = sticker?.amount;
    if (
      typeof amount !== 'number' ||
      !Number.isInteger(amount) ||
      amount <= 0 ||
      amount > 999_999_999
    )
      return null;
    return { amount, currency: 'IDR' };
  }

  private serializeAskStock(value: Prisma.JsonValue | null): StoryApi['askStock'] {
    const ask = jsonObject(value);
    if (!ask) return null;
    return { productId: typeof ask.productId === 'string' ? ask.productId : null };
  }

  private async buildProductMap(
    inputs: Array<{ authorId: string; productTags: Prisma.JsonValue }>,
  ): Promise<Map<string, PublicProduct>> {
    const wanted = new Map<string, Set<string>>();
    for (const input of inputs) {
      for (const tag of parseProductTagPositions(input.productTags)) {
        const ids = wanted.get(input.authorId) ?? new Set<string>();
        ids.add(tag.productId);
        wanted.set(input.authorId, ids);
      }
    }
    const allIds = [...new Set([...wanted.values()].flatMap(set => [...set]))];
    const authorIds = [...wanted.keys()];
    if (!allIds.length || !authorIds.length) return new Map();
    const rows = await this.prisma.userShowcase.findMany({
      where: {
        id: { in: allIds },
        userId: { in: authorIds },
        isActive: true,
        visibility: 'PUBLIC',
        deletedAt: null,
      },
      select: {
        id: true,
        userId: true,
        title: true,
        priceMin: true,
        images: {
          where: { kind: 'image' },
          orderBy: { sortOrder: 'asc' },
          take: 1,
          select: { imageUrl: true, fileKey: true },
        },
      },
    });
    const map = new Map<string, PublicProduct>();
    for (const row of rows as PublicProduct[]) map.set(`${row.userId}:${row.id}`, row);
    return map;
  }

  private async serializeProductTags(
    authorId: string,
    tags: ProductTagPosition[],
  ): Promise<StoryApi['productTags']> {
    const map = await this.buildProductMap([
      { authorId, productTags: tags as unknown as Prisma.JsonValue },
    ]);
    return Promise.all(
      tags.map(async tag => {
        const product = map.get(`${authorId}:${tag.productId}`);
        if (!product) return null;
        return {
          productId: product.id,
          title: product.title,
          coverUrl: await this.productCoverUrl(product),
          priceAmount: product.priceMin === null ? null : Number(product.priceMin),
          x: tag.x,
          y: tag.y,
        };
      }),
    ).then(items => items.filter((item): item is NonNullable<typeof item> => item !== null));
  }

  private async productCoverUrl(product: PublicProduct): Promise<string | null> {
    const image = product.images[0];
    if (!image) return null;
    if (image.fileKey && isSafeFileKey(image.fileKey)) {
      try {
        return await this.uploadService.generateDownloadUrl(
          image.fileKey,
          STORY_LIFETIME_MS / 1000,
        );
      } catch {
        return null;
      }
    }
    return image.imageUrl || null;
  }

  private async validateAskStockForOwner(
    userId: string,
    input: CreateStoryDto['askStock'],
  ): Promise<{ productId: string | null } | null> {
    if (input == null) return null;
    const productId = input.productId ?? null;
    if (productId === null) return { productId: null };
    const product = await this.prisma.userShowcase.findFirst({
      where: { id: productId, userId, isActive: true, visibility: 'PUBLIC', deletedAt: null },
      select: { id: true },
    });
    if (!product)
      throw new BadRequestException({
        code: 'STORY_PRODUCT_TAG_INVALID',
        message: 'Produk Tanya Stok harus milik Anda dan tampil di etalase.',
      });
    return { productId };
  }

  private validateHighlightTitle(value: string): string {
    const title = value.trim();
    if (!title)
      throw new BadRequestException({
        code: 'STORY_HIGHLIGHT_TITLE_REQUIRED',
        message: 'Judul sorotan wajib diisi.',
      });
    if (title.length > 24)
      throw new BadRequestException({
        code: 'STORY_HIGHLIGHT_TITLE_TOO_LONG',
        message: 'Judul sorotan maksimal 24 karakter.',
      });
    return title;
  }

  private validateHighlightStoryIds(input: string[]): string[] {
    if (
      !Array.isArray(input) ||
      input.length < 1 ||
      input.length > STORY_HIGHLIGHT_ITEMS_MAX ||
      new Set(input).size !== input.length
    ) {
      throw new BadRequestException({
        code: 'STORY_HIGHLIGHT_ITEMS_INVALID',
        message: 'Sorotan harus berisi 1 sampai 30 story unik.',
      });
    }
    return input;
  }

  private async getOwnedActiveStories(userId: string, ids: string[]): Promise<StoryRecord[]> {
    const rows = await this.prisma.story.findMany({
      where: { id: { in: ids }, authorId: userId, ...activeStoryWhere(new Date()) },
      orderBy: { createdAt: 'asc' },
      include: {
        author: { select: AUTHOR_SELECT },
        views: { where: { viewerId: userId }, select: { id: true } },
        reactions: { where: { viewerId: userId }, select: { emoji: true } },
        _count: { select: { views: true } },
      },
    });
    if (rows.length !== ids.length) {
      throw new BadRequestException({
        code: 'STORY_HIGHLIGHT_ITEMS_INVALID',
        message: 'Semua story sorotan harus aktif dan milik Anda.',
      });
    }
    const byId = new Map(rows.map(row => [row.id, row as unknown as StoryRecord]));
    return ids.map(id => byId.get(id)!);
  }

  private async createHighlightSnapshots(
    userId: string,
    rows: StoryRecord[],
    copiedKeys: string[],
  ): Promise<Record<string, unknown>[]> {
    const serialized = await this.serializeStories(rows, userId, false);
    const snapshots: Record<string, unknown>[] = [];
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      const serializedStory = serialized[index];
      let archivedMediaKey: string | null = null;
      if (row.mediaKey) {
        archivedMediaKey = this.newHighlightFileKey(userId);
        copiedKeys.push(archivedMediaKey);
        await this.localStorage.copyFile(row.mediaKey, archivedMediaKey);
      }
      snapshots.push({
        ...serializedStory,
        mediaUrl: null,
        mediaKey: archivedMediaKey,
        audience: null,
        viewed: false,
        viewCount: 0,
        myReaction: null,
      });
    }
    return snapshots;
  }

  private newHighlightFileKey(userId: string): string {
    return `uploads/story-highlights/${userId}/${Date.now()}-${createId()}.jpg`;
  }

  private highlightMediaKeys(snapshots: unknown[]): string[] {
    return snapshots.flatMap(raw => {
      const item = jsonObject(raw as Prisma.JsonValue);
      return typeof item?.mediaKey === 'string' && isSafeFileKey(item.mediaKey)
        ? [item.mediaKey]
        : [];
    });
  }

  private async serializeHighlight(highlight: {
    id: string;
    title: string;
    coverStoryId: string | null;
    storyIds: string[];
    stories: Prisma.JsonValue;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
  }): Promise<object> {
    const rawStories = Array.isArray(highlight.stories) ? highlight.stories : [];
    const positions: Array<{ authorId: string; productTags: Prisma.JsonValue }> = [];
    for (const raw of rawStories) {
      const item = jsonObject(raw as Prisma.JsonValue);
      if (item && Array.isArray(item.productTags)) {
        positions.push({
          authorId: highlight.userId,
          productTags: item.productTags as Prisma.JsonValue,
        });
      }
    }
    const productMap = await this.buildProductMap(positions);
    const stories = await Promise.all(
      rawStories.map(async (raw): Promise<StoryApi | null> => {
        const item = jsonObject(raw as Prisma.JsonValue);
        if (!item || typeof item.id !== 'string') return null;
        const tagsRaw = Array.isArray(item.productTags) ? item.productTags : [];
        const productTags = await Promise.all(
          tagsRaw.map(async tagRaw => {
            const tag = jsonObject(tagRaw as Prisma.JsonValue);
            if (
              !tag ||
              typeof tag.productId !== 'string' ||
              typeof tag.x !== 'number' ||
              typeof tag.y !== 'number'
            )
              return null;
            const product = productMap.get(`${highlight.userId}:${tag.productId}`);
            if (!product) return null;
            return {
              productId: product.id,
              title: product.title,
              coverUrl: await this.productCoverUrl(product),
              priceAmount: product.priceMin === null ? null : Number(product.priceMin),
              x: tag.x,
              y: tag.y,
            };
          }),
        );
        const mediaKey =
          typeof item.mediaKey === 'string' && isSafeFileKey(item.mediaKey) ? item.mediaKey : null;
        const price = jsonObject(item.priceSticker as Prisma.JsonValue);
        const ask = jsonObject(item.askStock as Prisma.JsonValue);
        return {
          id: item.id,
          author: item.author as StoryApi['author'],
          kind: item.kind === 'text' ? 'text' : 'image',
          mediaUrl: mediaKey
            ? await this.uploadService.generateDownloadUrl(
                mediaKey,
                (STORY_LIFETIME_MS / 1000) * 365,
              )
            : null,
          text: typeof item.text === 'string' ? item.text : null,
          backgroundColor: typeof item.backgroundColor === 'string' ? item.backgroundColor : null,
          productTags: productTags.filter((tag): tag is NonNullable<typeof tag> => tag !== null),
          priceSticker:
            price && typeof price.amount === 'number'
              ? { amount: price.amount, currency: 'IDR' }
              : null,
          askStock: ask
            ? { productId: typeof ask.productId === 'string' ? ask.productId : null }
            : null,
          createdAt: toDateString(item.createdAt) ?? '',
          expiresAt: toDateString(item.expiresAt) ?? '',
          viewed: false,
          viewCount: 0,
          myReaction: null,
          audience: null,
        };
      }),
    );
    const cleanStories = stories.filter((item): item is StoryApi => item !== null);
    const cover =
      cleanStories.find(item => item.id === highlight.coverStoryId) ?? cleanStories[0] ?? null;
    return {
      id: highlight.id,
      title: highlight.title,
      coverUrl: cover?.mediaUrl ?? null,
      storyCount: cleanStories.length,
      stories: cleanStories,
      createdAt: highlight.createdAt.toISOString(),
      updatedAt: highlight.updatedAt.toISOString(),
    };
  }

  private async isBlocked(viewerId: string, authorId: string): Promise<boolean> {
    if (viewerId === authorId) return false;
    const block = await this.prisma.blockList.findFirst({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: authorId },
          { blockerId: authorId, blockedId: viewerId },
        ],
      },
      select: { id: true },
    });
    return !!block;
  }

  private async blockedAuthorIds(viewerId: string, authorIds: string[]): Promise<Set<string>> {
    const candidates = [...new Set(authorIds)].filter(id => id !== viewerId);
    if (!candidates.length) return new Set();
    const rows = await this.prisma.blockList.findMany({
      where: {
        OR: [
          { blockerId: viewerId, blockedId: { in: candidates } },
          { blockedId: viewerId, blockerId: { in: candidates } },
        ],
      },
      select: { blockerId: true, blockedId: true },
    });
    return new Set(rows.map(row => (row.blockerId === viewerId ? row.blockedId : row.blockerId)));
  }

  private async activeBannedAuthorIds(authorIds: string[], now: Date): Promise<Set<string>> {
    const ids = [...new Set(authorIds)];
    if (!ids.length) return new Set();
    const rows = await this.prisma.storyFeatureBan.findMany({
      where: {
        userId: { in: ids },
        isActive: true,
        OR: [{ bannedUntil: null }, { bannedUntil: { gt: now } }],
      },
      select: { userId: true },
    });
    return new Set(rows.map(row => row.userId));
  }

  private async viewerPublicId(viewerId: string): Promise<string> {
    const viewer = await this.prisma.user.findUnique({
      where: { id: viewerId },
      select: { userId: true },
    });
    if (!viewer) throw storyNotFound();
    return viewer.userId;
  }

  private async emitStoryCreated(story: {
    id: string;
    authorId: string;
    author: AuthorRecord;
    audience: Prisma.JsonValue;
    createdAt: Date;
  }): Promise<void> {
    const savedProfiles = await this.prisma.userSavedProfile.findMany({
      where: {
        savedUserId: story.authorId,
        user: { isActive: true, isBanned: false, deletedAt: null },
      },
      select: { userId: true, user: { select: { userId: true } } },
    });
    const authorBlocked = await this.activeBannedAuthorIds([story.authorId], new Date());
    if (authorBlocked.has(story.authorId)) return;
    const mutedProfiles = savedProfiles.length
      ? await this.prisma.storyMute.findMany({
          where: {
            authorId: story.authorId,
            viewerId: { in: savedProfiles.map(row => row.userId) },
          },
          select: { viewerId: true },
        })
      : [];
    const mutedIds = new Set(mutedProfiles.map(row => row.viewerId));
    for (const saved of savedProfiles) {
      if (!storyAudienceAllows(story.audience, saved.user.userId)) continue;
      if (mutedIds.has(saved.userId)) continue;
      if (await this.isBlocked(saved.userId, story.authorId)) continue;
      this.realtime.emitToUser(saved.userId, 'story.created', {
        authorUserId: story.author.userId,
        storyId: story.id,
        createdAt: story.createdAt.toISOString(),
      });
    }
  }

  private async storyVisibilityRecipientIds(story: {
    id: string;
    authorId: string;
    audience: Prisma.JsonValue;
  }): Promise<string[]> {
    const [saved, views, reactions] = await Promise.all([
      this.prisma.userSavedProfile.findMany({
        where: { savedUserId: story.authorId },
        select: { userId: true, user: { select: { userId: true } } },
      }),
      this.prisma.storyView.findMany({ where: { storyId: story.id }, select: { viewerId: true } }),
      this.prisma.storyReaction.findMany({
        where: { storyId: story.id },
        select: { viewerId: true },
      }),
    ]);
    const recipients = new Set<string>([
      ...saved
        .filter(row => storyAudienceAllows(story.audience, row.user.userId))
        .map(row => row.userId),
      ...views.map(row => row.viewerId),
      ...reactions.map(row => row.viewerId),
    ]);
    recipients.delete(story.authorId);
    return [...recipients];
  }

  private async emitStoryVisibilityEvent(
    story: { id: string; authorId: string; author: AuthorRecord; audience: Prisma.JsonValue },
    event: 'story.deleted' | 'story.expired',
  ): Promise<void> {
    const recipients = await this.storyVisibilityRecipientIds(story);
    this.emitStoryVisibilityToRecipients(story, event, recipients);
  }

  private emitStoryVisibilityToRecipients(
    story: { id: string; author: AuthorRecord },
    event: 'story.deleted' | 'story.expired',
    recipients: string[],
  ): void {
    for (const recipientId of recipients) {
      this.realtime.emitToUser(recipientId, event, {
        authorUserId: story.author.userId,
        storyId: story.id,
      });
    }
  }
}
