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
  let upload: { generateDownloadUrl: jest.Mock; cleanupFileKeys: jest.Mock };

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
      storyFeatureBan: { findMany: jest.fn().mockResolvedValue([]) },
      story: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockImplementation(async () => [row]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      storyMediaUpload: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
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
    };
    service = new StoriesService(
      prisma as never,
      upload as never,
      {} as never,
      realtime as never,
      {} as never,
      chat as never,
      { logUserAction: jest.fn() } as never,
    );
  });

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
      errors: [{ fileKey: `uploads/story-media/${AUTHOR_ID}/story.jpg`, reason: 'storage deletion failed' }],
    });

    const result = await service.cleanupExpiredAndRetained(new Date());

    expect(result.mediaTickets).toBe(0);
    expect(prisma.storyMediaUpload.deleteMany).not.toHaveBeenCalled();
  });

  it('keeps a retained Story row until its media has been deleted', async () => {
    prisma.story.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: STORY_ID,
          authorId: AUTHOR_ID,
          mediaKey: `uploads/story-media/${AUTHOR_ID}/story.jpg`,
        },
      ]);
    upload.cleanupFileKeys.mockResolvedValue({
      deleted: 0,
      errors: [{ fileKey: `uploads/story-media/${AUTHOR_ID}/story.jpg`, reason: 'storage deletion failed' }],
    });

    const result = await service.cleanupExpiredAndRetained(new Date());

    expect(result.deleted).toBe(0);
    expect(prisma.story.deleteMany).not.toHaveBeenCalled();
  });
});
