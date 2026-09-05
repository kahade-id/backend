import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { HelpCenterService } from '../help-center.service';
import { PrismaService } from '../../../prisma/prisma.service';

const mockPrisma = {
  faqCategory: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  faqItem: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn(), delete: jest.fn() },
};

describe('HelpCenterService', () => {
  let service: HelpCenterService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HelpCenterService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<HelpCenterService>(HelpCenterService);
  });

  it('should be defined', () => expect(service).toBeDefined());

  describe('getCategories', () => {
    it('returns categories with Indonesian text by default', async () => {
      mockPrisma.faqCategory.findMany.mockResolvedValue([{
        id: 'c1', slug: 'general', name: 'Umum', nameEn: 'General',
        description: 'desc id', descriptionEn: 'desc en', icon: 'help',
        items: [{ id: 'i1', question: 'Q?', questionEn: 'Q-en?', answer: 'A', answerEn: 'A-en', viewCount: 5 }],
      }]);
      const result = await service.getCategories('id');
      expect(result[0].name).toBe('Umum');
      expect(result[0].items[0].question).toBe('Q?');
    });

    it('returns English text when lang=en', async () => {
      mockPrisma.faqCategory.findMany.mockResolvedValue([{
        id: 'c1', slug: 'general', name: 'Umum', nameEn: 'General',
        description: 'desc id', descriptionEn: 'desc en', icon: 'help',
        items: [{ id: 'i1', question: 'Q?', questionEn: 'Q-en?', answer: 'A', answerEn: 'A-en', viewCount: 5 }],
      }]);
      const result = await service.getCategories('en');
      expect(result[0].name).toBe('General');
      expect(result[0].items[0].question).toBe('Q-en?');
    });

    it('falls back to ID when EN missing', async () => {
      mockPrisma.faqCategory.findMany.mockResolvedValue([{
        id: 'c1', slug: 'general', name: 'Umum', nameEn: null,
        description: 'desc', descriptionEn: null, icon: null,
        items: [],
      }]);
      const result = await service.getCategories('en');
      expect(result[0].name).toBe('Umum');
    });
  });

  describe('getCategoryBySlug', () => {
    it('returns category by slug', async () => {
      mockPrisma.faqCategory.findFirst.mockResolvedValue({
        id: 'c1', slug: 'pay', name: 'Pembayaran', nameEn: 'Payment',
        description: 'd', descriptionEn: 'd-en', icon: null, items: [],
      });
      const result = await service.getCategoryBySlug('pay');
      expect((result as any).name).toBe('Pembayaran');
    });

    it('throws NotFoundException when slug missing', async () => {
      mockPrisma.faqCategory.findFirst.mockResolvedValue(null);
      await expect(service.getCategoryBySlug('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('searchFaq', () => {
    it('returns empty array when query too short', async () => {
      const result = await service.searchFaq('a');
      expect(result).toEqual([]);
      expect(mockPrisma.faqItem.findMany).not.toHaveBeenCalled();
    });

    it('returns empty array when query empty/whitespace', async () => {
      const result = await service.searchFaq('  ');
      expect(result).toEqual([]);
    });

    it('searches FAQ items with case-insensitive OR', async () => {
      mockPrisma.faqItem.findMany.mockResolvedValue([
        { id: 'i1', question: 'How?', questionEn: null, answer: 'A', answerEn: null, viewCount: 1, category: { slug: 'g', name: 'General', nameEn: 'General' } },
      ]);
      const result = await service.searchFaq('how');
      expect(result).toHaveLength(1);
      expect(mockPrisma.faqItem.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ isActive: true, category: { isActive: true } }),
        orderBy: [{ viewCount: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
        take: 20,
      }));
    });
  });

  describe('trackView', () => {
    it('increments view count', async () => {
      mockPrisma.faqItem.findFirst.mockResolvedValue({ id: 'i1' });
      mockPrisma.faqItem.update.mockResolvedValue({});
      await service.trackView('i1');
      expect(mockPrisma.faqItem.update).toHaveBeenCalledWith({
        where: { id: 'i1' },
        data: { viewCount: { increment: 1 } },
      });
    });

    it('throws NotFoundException when item missing or inactive', async () => {
      mockPrisma.faqItem.findFirst.mockResolvedValue(null);
      await expect(service.trackView('i1')).rejects.toThrow(NotFoundException);
    });

    it('only tracks active articles in active categories', async () => {
      mockPrisma.faqItem.findFirst.mockResolvedValue({ id: 'i1' });
      mockPrisma.faqItem.update.mockResolvedValue({});
      await service.trackView('i1');
      expect(mockPrisma.faqItem.findFirst).toHaveBeenCalledWith({
        where: { id: 'i1', isActive: true, category: { isActive: true } },
        select: { id: true },
      });
    });
  });

  describe('admin operations', () => {
    it('adminGetCategories returns categories with item count', async () => {
      mockPrisma.faqCategory.findMany.mockResolvedValue([{ id: 'c1', _count: { items: 3 } }]);
      const result = await service.adminGetCategories();
      expect(result).toHaveLength(1);
    });

    it('adminCreateCategory creates category', async () => {
      mockPrisma.faqCategory.create.mockResolvedValue({ id: 'c1' });
      await service.adminCreateCategory({ name: 'X', slug: 'x' } as any);
      expect(mockPrisma.faqCategory.create).toHaveBeenCalled();
    });

    it('adminUpdateCategory updates category', async () => {
      mockPrisma.faqCategory.update.mockResolvedValue({});
      await service.adminUpdateCategory('c1', { name: 'Y' } as any);
      expect(mockPrisma.faqCategory.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { name: 'Y' } });
    });

    it('adminDeleteCategory deletes', async () => {
      mockPrisma.faqCategory.delete.mockResolvedValue({});
      const result = await service.adminDeleteCategory('c1');
      expect(result.message).toBe('Category deleted');
    });

    it('adminCreateItem creates item', async () => {
      mockPrisma.faqItem.create.mockResolvedValue({ id: 'i1' });
      await service.adminCreateItem({ question: 'Q?', answer: 'A', categoryId: 'c1' } as any);
      expect(mockPrisma.faqItem.create).toHaveBeenCalled();
    });

    it('adminUpdateItem updates', async () => {
      mockPrisma.faqItem.update.mockResolvedValue({});
      await service.adminUpdateItem('i1', { question: 'Q2?' } as any);
      expect(mockPrisma.faqItem.update).toHaveBeenCalled();
    });

    it('adminDeleteItem deletes', async () => {
      mockPrisma.faqItem.delete.mockResolvedValue({});
      const result = await service.adminDeleteItem('i1');
      expect(result.message).toBe('FAQ item deleted');
    });
  });
});
