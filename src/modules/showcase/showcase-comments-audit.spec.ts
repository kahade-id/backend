import { ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ShowcaseService } from './showcase.service';

/**
 * Audit 2026-10-03 — Worker C2.
 * (a) BFE-117/FAL-009: like toggle komentar idempoten per user.
 * (b) FAL-027: hapus komentar = soft-delete; balasan TETAP ada.
 */
describe('ShowcaseService — comment like & soft-delete (audit 2026-10-03)', () => {
  function makeService() {
    const reaction = {
      upsert: jest.fn(),
      deleteMany: jest.fn(),
      groupBy: jest.fn(),
      findMany: jest.fn(),
    };
    const showcaseComment = {
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    };
    // BES-04 (audit etalase 2026-10-10): toggleCommentLike kini memverifikasi
    // item terlihat (findVisibleShowcase → blockList.findMany + userShowcase.findFirst)
    // dan tidak ada relasi blokir (blockList.findFirst).
    const userShowcase = {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn().mockResolvedValue({
        id: 's1',
        userId: 'owner-1',
        isActive: true,
        visibility: 'PUBLIC',
        deletedAt: null,
        user: { id: 'owner-1', username: 'owner', fullName: 'Owner', avatarUrl: null },
        images: [],
      }),
    };
    const blockList = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    };
    const prisma: any = {
      showcaseComment,
      showcaseCommentReaction: reaction,
      userShowcase,
      blockList,
      $transaction: jest.fn(async (cb: any) => cb({ showcaseComment, userShowcase })),
    };
    const svc = new ShowcaseService(
      prisma,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
      undefined as any,
    );
    return { svc, prisma, reaction, showcaseComment, userShowcase, blockList };
  }

  const visibleComment = { id: 'c1', isHidden: false, deletedAt: null, showcaseId: 's1' };

  function mockCounts(reaction: any, likes: number, dislikes: number, vote: number) {
    reaction.groupBy.mockResolvedValue([
      { commentId: 'c1', value: 1, _count: { _all: likes } },
      { commentId: 'c1', value: -1, _count: { _all: dislikes } },
    ]);
    reaction.findMany.mockResolvedValue(vote !== 0 ? [{ commentId: 'c1', value: vote }] : []);
  }

  describe('toggleCommentLike (BFE-117/FAL-009)', () => {
    it('like (value=1) → upsert + ringkasan {likes, dislikes, userVote}', async () => {
      const { svc, prisma, reaction } = makeService();
      prisma.showcaseComment.findUnique.mockResolvedValue(visibleComment);
      mockCounts(reaction, 12, 1, 1);

      const out = await svc.toggleCommentLike('u1', 'c1', 1);

      expect(reaction.upsert).toHaveBeenCalledWith({
        where: { commentId_userId: { commentId: 'c1', userId: 'u1' } },
        create: { commentId: 'c1', userId: 'u1', value: 1 },
        update: { value: 1 },
      });
      expect(out).toEqual({ likes: 12, dislikes: 1, userVote: 1 });
    });

    it('idempoten: like dua kali dengan value sama → upsert yang sama, tidak ada duplikat', async () => {
      const { svc, prisma, reaction } = makeService();
      prisma.showcaseComment.findUnique.mockResolvedValue(visibleComment);
      mockCounts(reaction, 5, 0, 1);

      await svc.toggleCommentLike('u1', 'c1', 1);
      const out = await svc.toggleCommentLike('u1', 'c1', 1);

      expect(reaction.upsert).toHaveBeenCalledTimes(2);
      expect(reaction.upsert).toHaveBeenNthCalledWith(2, {
        where: { commentId_userId: { commentId: 'c1', userId: 'u1' } },
        create: { commentId: 'c1', userId: 'u1', value: 1 },
        update: { value: 1 },
      });
      expect(out.userVote).toBe(1);
    });

    it('value=0 → hapus reaksi (deleteMany), userVote kembali 0', async () => {
      const { svc, prisma, reaction } = makeService();
      prisma.showcaseComment.findUnique.mockResolvedValue(visibleComment);
      mockCounts(reaction, 4, 0, 0);

      const out = await svc.toggleCommentLike('u1', 'c1', 0);

      expect(reaction.deleteMany).toHaveBeenCalledWith({ where: { commentId: 'c1', userId: 'u1' } });
      expect(reaction.upsert).not.toHaveBeenCalled();
      expect(out).toEqual({ likes: 4, dislikes: 0, userVote: 0 });
    });

    it('value di luar {1,-1,0} → 400', async () => {
      const { svc } = makeService();
      await expect(svc.toggleCommentLike('u1', 'c1', 2)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('komentar hidden → 403; komentar soft-deleted/tidak ada → 404', async () => {
      const { svc, prisma } = makeService();
      prisma.showcaseComment.findUnique.mockResolvedValue({ id: 'c1', isHidden: true, deletedAt: null });
      await expect(svc.toggleCommentLike('u1', 'c1', 1)).rejects.toBeInstanceOf(ForbiddenException);

      prisma.showcaseComment.findUnique.mockResolvedValue({ id: 'c1', isHidden: false, deletedAt: new Date() });
      await expect(svc.toggleCommentLike('u1', 'c1', 1)).rejects.toBeInstanceOf(NotFoundException);

      prisma.showcaseComment.findUnique.mockResolvedValue(null);
      await expect(svc.toggleCommentLike('u1', 'c1', 1)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deleteComment — soft-delete (FAL-027)', () => {
    function mockExisting(prisma: any, over: any = {}) {
      prisma.showcaseComment.findUnique.mockResolvedValue({
        id: 'c1',
        userId: 'author1',
        showcaseId: 's1',
        parentId: null,
        isHidden: false,
        deletedAt: null,
        ...over,
      });
      prisma.userShowcase.findUnique.mockResolvedValue({ id: 's1', userId: 'owner1' });
    }

    it('penulis menghapus: set deletedAt/deletedBy/deleteReason, TIDAK hard-delete', async () => {
      const { svc, prisma, showcaseComment } = makeService();
      mockExisting(prisma);

      await svc.deleteComment('author1', 'c1', 'typo');

      expect(showcaseComment.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: {
          deletedAt: expect.any(Date),
          deletedBy: 'author1',
          deleteReason: 'typo',
        },
      });
      expect(showcaseComment.delete).not.toHaveBeenCalled();
      expect(showcaseComment.deleteMany).not.toHaveBeenCalled();
    });

    it('hanya komentar itu sendiri yang di-update — tidak ada operasi terhadap balasan (parentId)', async () => {
      const { svc, prisma, showcaseComment } = makeService();
      mockExisting(prisma);

      await svc.deleteComment('author1', 'c1');

      // Satu-satunya operasi tulis ke showcaseComment adalah update baris 'c1'.
      expect(showcaseComment.update).toHaveBeenCalledTimes(1);
      for (const call of showcaseComment.update.mock.calls) {
        expect(call[0].where).toEqual({ id: 'c1' });
        expect(JSON.stringify(call[0])).not.toContain('parentId');
      }
    });

    it('commentCount hanya dikurangi 1 (balasan tidak dihitung ulang)', async () => {
      const { svc, prisma, userShowcase } = makeService();
      mockExisting(prisma);

      await svc.deleteComment('author1', 'c1');

      expect(userShowcase.updateMany).toHaveBeenCalledWith({
        where: { id: 's1', commentCount: { gt: 0 } },
        data: { commentCount: { decrement: 1 } },
      });
    });

    it('komentar yang sudah soft-deleted → 404 (tidak bisa dihapus dua kali)', async () => {
      const { svc, prisma } = makeService();
      mockExisting(prisma, { deletedAt: new Date() });
      await expect(svc.deleteComment('author1', 'c1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('bukan penulis & bukan pemilik showcase → 403', async () => {
      const { svc, prisma } = makeService();
      mockExisting(prisma);
      await expect(svc.deleteComment('randomUser', 'c1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
