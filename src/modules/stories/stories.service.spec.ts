import * as os from 'os';
import { ForbiddenException } from '@nestjs/common';
import { StoriesService } from './stories.service';

const VIEWER_ID = 'clxviewer0000000000000001';
const VIEWER_PUBLIC_ID = 'USR-viewer00000001';
const AUTHOR_ID = 'clxauthor0000000000000001';
const AUTHOR_PUBLIC_ID = 'USR-author00000001';
const STORY_ID = 'clxstory00000000000000001';

function storyRow(audience: unknown) {
  const createdAt = new Date(Date.now() - 10 * 60 * 1000);
  return {
    id: STORY_ID,
    authorId: AUTHOR_ID,
    kind: 'TEXT',
    mediaKey: null,
    textContent: 'Halo',
    backgroundColor: '#112233',
    audience,
    productTags: [],
    priceSticker: null,
    askStock: null,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60 * 1000),
    deletedAt: null,
    hiddenAt: null,
    hiddenUntil: null,
    hiddenReason: null,
    author: {
      id: AUTHOR_ID,
      userId: AUTHOR_PUBLIC_ID,
      username: 'author',
      fullName: 'Story Author',
      avatarUrl: null,
    },
    views: [],
    reactions: [],
    _count: { views: 0 },
  };
}

describe('StoriesService saved-profile visibility and per-story privacy', () => {
  let service: StoriesService;
  let prisma: Record<string, any>;
  let row: ReturnType<typeof storyRow>;
  let realtime: { emitToUser: jest.Mock };
  let chat: { createInquiry: jest.Mock };
  let upload: {
    generateDownloadUrl: jest.Mock;
    cleanupFileKeys: jest.Mock;
    uploadDirect: jest.Mock;
  };
  let videoProcessing: {
    isAvailable: jest.Mock;
    probeVideo: jest.Mock;
    generateThumbnail: jest.Mock;
  };
  let localStorage: { resolvePath: jest.Mock; deleteFile: jest.Mock };

  beforeEach(() => {
    row = storyRow({ mode: 'all_savers' });
    prisma = {
      user: {
        findUnique: jest.fn(async ({ where }: { where: Record<string, string> }) => {
          if (where.userId === AUTHOR_PUBLIC_ID) {
            return {
              id: AUTHOR_ID,
              userId: AUTHOR_PUBLIC_ID,
              username: 'author',
              fullName: 'Story Author',
              avatarUrl: null,
              isActive: true,
              isBanned: false,
              deletedAt: null,
            };
          }
          if (where.id === VIEWER_ID) {
            return { id: VIEWER_ID, userId: VIEWER_PUBLIC_ID };
          }
          return null;
        }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      userSavedProfile: {
        findUnique: jest.fn().mockResolvedValue({ id: 'saved-profile-row' }),
      },
      blockList: { findFirst: jest.fn().mockResolvedValue(null) },
      storyFeatureBan: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      story: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockImplementation(async () => [row]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      storyMediaUpload: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      },
      userShowcase: { findMany: jest.fn().mockResolvedValue([]) },
      storyView: { findMany: jest.fn().mockResolvedValue([]) },
      storyMute: { findMany: jest.fn().mockResolvedValue([]) },
      storyReaction: { findMany: jest.fn().mockResolvedValue([]) },
    };
    realtime = { emitToUser: jest.fn() };
    chat = { createInquiry: jest.fn().mockResolvedValue({ room: { id: 'room-reply-1' } }) };
    upload = {
      generateDownloadUrl: jest.fn().mockResolvedValue('https://storage.example/story.jpg'),
      cleanupFileKeys: jest.fn().mockResolvedValue({ deleted: 1, errors: [] }),
      uploadDirect: jest.fn(async (_u: string, _p: string, name: string) => ({
        fileKey: `uploads/story-media/${AUTHOR_ID}/${name}`,
      })),
    };
    videoProcessing = {
      isAvailable: jest.fn(() => true),
      probeVideo: jest.fn().mockResolvedValue({ durationSec: 12.4, width: 1080, height: 1920 }),
      generateThumbnail: jest.fn().mockResolvedValue(undefined),
    };
    localStorage = {
      resolvePath: jest.fn((key: string) => `${os.tmpdir()}/kahade-story-spec/${key}`),
      deleteFile: jest.fn().mockResolvedValue(true),
    };
    service = new StoriesService(
      prisma as never,
      upload as never,
      localStorage as never,
      realtime as never,
      {} as never,
      chat as never,
      { logUserAction: jest.fn() } as never,
      videoProcessing as never,
    );
  });

  function allowStoryFeature(): void {
    prisma.user.findUnique.mockImplementation(
      async ({ where }: { where: Record<string, string> }) =>
        where.id === AUTHOR_ID
          ? {
              id: AUTHOR_ID,
              userId: AUTHOR_PUBLIC_ID,
              isActive: true,
              isBanned: false,
              deletedAt: null,
            }
          : null,
    );
  }

  it('requires a saved-profile relationship; a follow does not grant Story access', async () => {
    prisma.userSavedProfile.findUnique.mockResolvedValue(null);
    // A follow edge is intentionally not queried by Story access checks.
    prisma.follow = { findFirst: jest.fn().mockResolvedValue({ id: 'follow-row' }) };

    await expect(service.getUserStories(VIEWER_ID, AUTHOR_PUBLIC_ID)).rejects.toMatchObject({
      response: { code: 'STORY_NOT_VISIBLE' },
    });
    expect(prisma.userSavedProfile.findUnique).toHaveBeenCalledWith({
      where: { userId_savedUserId: { userId: VIEWER_ID, savedUserId: AUTHOR_ID } },
      select: { id: true },
    });
    expect(prisma.follow.findFirst).not.toHaveBeenCalled();
    expect(prisma.story.findMany).not.toHaveBeenCalled();
  });

  it('returns 403 when a saved-profile viewer is excluded from this Story', async () => {
    row = storyRow({ mode: 'savers_except', excludedUserIds: [VIEWER_PUBLIC_ID] });
    prisma.story.findMany.mockImplementation(async () => [row]);

    await expect(service.getUserStories(VIEWER_ID, AUTHOR_PUBLIC_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects an expired Story and applies the expiry predicate to direct reads', async () => {
    const expired = storyRow({ mode: 'all_savers' });
    expired.expiresAt = new Date(Date.now() - 1);
    prisma.story.findFirst.mockResolvedValue(expired);

    await expect(service.markViewed(VIEWER_ID, STORY_ID)).rejects.toMatchObject({
      response: { code: 'STORY_NOT_FOUND' },
    });
    expect(prisma.story.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ expiresAt: { gt: expect.any(Date) } }),
      }),
    );
  });

  it('creates a moderated chat inquiry for a reply and returns only roomId', async () => {
    prisma.story.findFirst.mockResolvedValue(row);

    const result = await service.replyToStory(VIEWER_ID, STORY_ID, '  Masih tersedia?  ');

    expect(result).toEqual({ roomId: 'room-reply-1' });
    expect(chat.createInquiry).toHaveBeenCalledWith(
      VIEWER_ID,
      { counterpartId: AUTHOR_ID, subject: 'Balasan story', message: 'Masih tersedia?' },
      STORY_ID,
    );
    expect(realtime.emitToUser).toHaveBeenCalledWith(AUTHOR_ID, 'story.reply.received', {
      storyId: STORY_ID,
      roomId: 'room-reply-1',
    });
  });

  it('returns active Story content to a saver not excluded by its audience', async () => {
    row = storyRow({ mode: 'savers_except', excludedUserIds: ['USR-someone-else'] });
    prisma.story.findMany.mockImplementation(async () => [row]);

    const result = (await service.getUserStories(VIEWER_ID, AUTHOR_PUBLIC_ID)) as {
      author: { userId: string };
      stories: Array<{ id: string; viewCount: number; audience: unknown }>;
    };

    expect(result.author.userId).toBe(AUTHOR_PUBLIC_ID);
    expect(result.stories).toHaveLength(1);
    expect(result.stories[0]).toMatchObject({ id: STORY_ID, viewCount: 0, audience: null });
  });

  it('retains an expired upload ticket for retry when storage deletion fails', async () => {
    prisma.story.findMany.mockResolvedValue([]);
    prisma.storyMediaUpload.findMany.mockResolvedValue([
      {
        id: 'media-ticket',
        authorId: AUTHOR_ID,
        fileKey: `uploads/story-media/${AUTHOR_ID}/story.jpg`,
      },
    ]);
    upload.cleanupFileKeys.mockResolvedValue({
      deleted: 0,
      errors: [
        {
          fileKey: `uploads/story-media/${AUTHOR_ID}/story.jpg`,
          reason: 'storage deletion failed',
        },
      ],
    });

    const result = await service.cleanupExpiredAndRetained(new Date());

    expect(result.mediaTickets).toBe(0);
    expect(prisma.storyMediaUpload.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps a retained Story row until its media has been deleted', async () => {
    prisma.story.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: STORY_ID,
        authorId: AUTHOR_ID,
        mediaKey: `uploads/story-media/${AUTHOR_ID}/story.jpg`,
      },
    ]);
    upload.cleanupFileKeys.mockResolvedValue({
      deleted: 0,
      errors: [
        {
          fileKey: `uploads/story-media/${AUTHOR_ID}/story.jpg`,
          reason: 'storage deletion failed',
        },
      ],
    });

    const result = await service.cleanupExpiredAndRetained(new Date());

    expect(result.deleted).toBe(0);
    expect(prisma.story.deleteMany).not.toHaveBeenCalled();
  });

  describe('video story upload (2026-10-10)', () => {
    it('stores a VIDEO ticket with poster + duration from ffprobe', async () => {
      allowStoryFeature();
      const result = await service.uploadStoryMedia(
        AUTHOR_ID,
        'clip.mp4',
        'video/mp4',
        Buffer.alloc(2048, 1),
      );
      expect(upload.uploadDirect).toHaveBeenCalledWith(
        AUTHOR_ID,
        'STORY_MEDIA',
        'clip.mp4',
        'video/mp4',
        expect.any(Buffer),
      );
      expect(videoProcessing.generateThumbnail).toHaveBeenCalledWith(
        expect.stringContaining('clip.mp4'),
        expect.stringContaining('-thumb-'),
        1,
        640,
      );
      expect(prisma.storyMediaUpload.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kind: 'VIDEO',
          durationMs: 12400,
          width: 1080,
          height: 1920,
          thumbnailKey: expect.stringMatching(/^uploads\/story-media\/.+-thumb-.+\.jpg$/),
        }),
      });
      expect(result).toMatchObject({ kind: 'video', durationMs: 12400 });
      expect(result.thumbnailUrl).toBe('https://storage.example/story.jpg');
    });

    it('rejects a video over 60 seconds and discards the stored file (fail-closed)', async () => {
      allowStoryFeature();
      videoProcessing.probeVideo.mockResolvedValue({ durationSec: 61, width: 720, height: 1280 });
      await expect(
        service.uploadStoryMedia(AUTHOR_ID, 'long.mp4', 'video/mp4', Buffer.alloc(2048, 1)),
      ).rejects.toMatchObject({ response: { code: 'VIDEO_TOO_LONG' } });
      expect(upload.cleanupFileKeys).toHaveBeenCalledWith(AUTHOR_ID, [
        `uploads/story-media/${AUTHOR_ID}/long.mp4`,
      ]);
      expect(prisma.storyMediaUpload.create).not.toHaveBeenCalled();
    });

    it('rejects a video over 50 MB before touching storage', async () => {
      allowStoryFeature();
      await expect(
        service.uploadStoryMedia(
          AUTHOR_ID,
          'big.mp4',
          'video/mp4',
          Buffer.alloc(50 * 1024 * 1024 + 1),
        ),
      ).rejects.toMatchObject({ response: { code: 'STORY_MEDIA_TOO_LARGE' } });
      expect(upload.uploadDirect).not.toHaveBeenCalled();
    });

    it('keeps the image path unchanged: no probe, IMAGE ticket', async () => {
      allowStoryFeature();
      const result = await service.uploadStoryMedia(
        AUTHOR_ID,
        'foto.jpg',
        'image/jpeg',
        Buffer.alloc(2048, 1),
      );
      expect(videoProcessing.probeVideo).not.toHaveBeenCalled();
      expect(prisma.storyMediaUpload.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ kind: 'IMAGE', thumbnailKey: null, durationMs: null }),
      });
      expect(result).toMatchObject({ kind: 'image', thumbnailUrl: null, durationMs: null });
    });

    it('retention removes the poster together with the expired video ticket', async () => {
      prisma.story.findMany.mockResolvedValue([]);
      prisma.storyMediaUpload.findMany.mockResolvedValue([
        {
          id: 'media-ticket',
          authorId: AUTHOR_ID,
          fileKey: `uploads/story-media/${AUTHOR_ID}/clip.mp4`,
          thumbnailKey: `uploads/story-media/${AUTHOR_ID}/clip-thumb.jpg`,
        },
      ]);
      await service.cleanupExpiredAndRetained(new Date());
      expect(upload.cleanupFileKeys).toHaveBeenCalledWith(AUTHOR_ID, [
        `uploads/story-media/${AUTHOR_ID}/clip.mp4`,
        `uploads/story-media/${AUTHOR_ID}/clip-thumb.jpg`,
      ]);
    });
  });
});
