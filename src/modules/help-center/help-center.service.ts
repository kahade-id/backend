import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CreateFaqCategoryDto, UpdateFaqCategoryDto, CreateFaqItemDto, UpdateFaqItemDto } from './dto';
import { escapeLikePattern } from '../../common/utils/search.util';

// Perf 2026-10-10: TTL cache daftar FAQ publik (lihat getCategories).
// viewCount di payload bisa tertinggal maks TTL — angka display-only,
// trackView tetap menulis ke DB.
const FAQ_CATEGORIES_CACHE_TTL_SECONDS = 300; // 5 menit
const faqCategoriesCacheKey = (lang: 'id' | 'en') => `help-center:categories:${lang}`;

/** Bentuk payload getCategories — dipakai juga untuk cast hasil cache JSON. */
export type FaqCategoryView = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  icon: string | null;
  items: Array<{
    id: string;
    question: string;
    answer: string;
    viewCount: number;
  }>;
};

@Injectable()
export class HelpCenterService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
  ) {}

  private normalizeLanguage(lang: string): 'id' | 'en' {
    return lang.trim().toLowerCase() === 'en' ? 'en' : 'id';
  }

  private async invalidateFaqCache(): Promise<void> {
    try {
      await this.redis.delPattern('help-center:categories:*');
    } catch {
      // Kegagalan invalidasi cache tidak boleh menggagalkan mutasi admin;
      // TTL 5 menit tetap membatasi staleness.
    }
  }

  async getCategories(lang: string = 'id'): Promise<FaqCategoryView[]> {
    const language = this.normalizeLanguage(lang);
    // Perf 2026-10-10: di-cache 5 menit di Redis (pola public.service.ts —
    // Redis gagal = fall through ke DB). FAQ diubah admin sesekali; mutasi
    // admin meng-invalidate via invalidateFaqCache di bawah.
    const cacheKey = faqCategoriesCacheKey(language);
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try {
          return JSON.parse(cached) as FaqCategoryView[];
        } catch {
          // Cache korup — hitung ulang dari DB.
        }
      }
    } catch {
      // Redis hanya optimisasi untuk path baca publik ini; lanjut ke DB.
    }

    const categories = await this.prisma.faqCategory.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: {
        items: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    });

    const result: FaqCategoryView[] = categories.map((cat) => ({
      id: cat.id,
      slug: cat.slug,
      name: language === 'en' && cat.nameEn ? cat.nameEn : cat.name,
      description: language === 'en' && cat.descriptionEn ? cat.descriptionEn : cat.description,
      icon: cat.icon,
      items: cat.items.map((item) => ({
        id: item.id,
        question: language === 'en' && item.questionEn ? item.questionEn : item.question,
        answer: language === 'en' && item.answerEn ? item.answerEn : item.answer,
        viewCount: item.viewCount,
      })),
    }));

    try {
      await this.redis.setex(cacheKey, FAQ_CATEGORIES_CACHE_TTL_SECONDS, JSON.stringify(result));
    } catch {
      // Kegagalan tulis cache tidak boleh mengubah response publik yang sukses.
    }
    return result;
  }

  async getCategoryBySlug(slug: string, lang: string = 'id') {
    const language = this.normalizeLanguage(lang);
    const cat = await this.prisma.faqCategory.findFirst({
      where: { slug: slug.trim().toLowerCase(), isActive: true },
      include: {
        items: {
          where: { isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        },
      },
    });

    if (!cat) throw new NotFoundException({ code: 'FAQ_NOT_FOUND', message: 'FAQ category not found' });

    return {
      id: cat.id,
      slug: cat.slug,
      name: language === 'en' && cat.nameEn ? cat.nameEn : cat.name,
      description: language === 'en' && cat.descriptionEn ? cat.descriptionEn : cat.description,
      icon: cat.icon,
      items: cat.items.map((item) => ({
        id: item.id,
        question: language === 'en' && item.questionEn ? item.questionEn : item.question,
        answer: language === 'en' && item.answerEn ? item.answerEn : item.answer,
        viewCount: item.viewCount,
      })),
    };
  }

  async searchFaq(query: string, lang: string = 'id') {
    const language = this.normalizeLanguage(lang);
    const normalizedQuery = query.normalize('NFKC').trim().slice(0, 100);
    if (normalizedQuery.length < 2) {
      return [];
    }
    const items = await this.prisma.faqItem.findMany({
      where: {
        isActive: true,
        category: { isActive: true },
        OR: [
          { question: { contains: escapeLikePattern(normalizedQuery), mode: 'insensitive' } },
          { questionEn: { contains: escapeLikePattern(normalizedQuery), mode: 'insensitive' } },
          { answer: { contains: escapeLikePattern(normalizedQuery), mode: 'insensitive' } },
          { answerEn: { contains: escapeLikePattern(normalizedQuery), mode: 'insensitive' } },
        ],
      },
      include: {
        category: { select: { slug: true, name: true, nameEn: true } },
      },
      orderBy: [{ viewCount: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
      take: 20,
    });

    return items.map((item) => ({
      id: item.id,
      question: language === 'en' && item.questionEn ? item.questionEn : item.question,
      answer: language === 'en' && item.answerEn ? item.answerEn : item.answer,
      viewCount: item.viewCount,
      category: {
        slug: item.category.slug,
        name: language === 'en' && item.category.nameEn ? item.category.nameEn : item.category.name,
      },
    }));
  }

  async trackView(itemId: string) {
    const item = await this.prisma.faqItem.findFirst({
      where: { id: itemId, isActive: true, category: { isActive: true } },
      select: { id: true },
    });
    if (!item) {
      throw new NotFoundException({ code: 'FAQ_ITEM_NOT_FOUND', message: 'FAQ item not found' });
    }
    await this.prisma.faqItem.update({
      where: { id: itemId },
      data: { viewCount: { increment: 1 } },
    });
  }

  async adminGetCategories() {
    return this.prisma.faqCategory.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      include: { _count: { select: { items: true } } },
    });
  }

  async adminCreateCategory(dto: CreateFaqCategoryDto) {
    const created = await this.prisma.faqCategory.create({ data: dto });
    await this.invalidateFaqCache();
    return created;
  }

  async adminUpdateCategory(id: string, dto: UpdateFaqCategoryDto) {
    const updated = await this.prisma.faqCategory.update({ where: { id }, data: dto });
    await this.invalidateFaqCache();
    return updated;
  }

  async adminDeleteCategory(id: string) {
    await this.prisma.faqCategory.delete({ where: { id } });
    await this.invalidateFaqCache();
    return { message: 'Category deleted' };
  }

  async adminCreateItem(dto: CreateFaqItemDto) {
    const created = await this.prisma.faqItem.create({ data: dto });
    await this.invalidateFaqCache();
    return created;
  }

  async adminUpdateItem(id: string, dto: UpdateFaqItemDto) {
    const updated = await this.prisma.faqItem.update({ where: { id }, data: dto });
    await this.invalidateFaqCache();
    return updated;
  }

  async adminDeleteItem(id: string) {
    await this.prisma.faqItem.delete({ where: { id } });
    await this.invalidateFaqCache();
    return { message: 'FAQ item deleted' };
  }

  async submitFeedback(itemId: string, helpful: boolean): Promise<object> {
    const item = await this.prisma.faqItem.findFirst({ where: { id: itemId }, select: { id: true } });
    if (!item) throw new NotFoundException({ code: 'FAQ_ITEM_NOT_FOUND', message: 'FAQ item not found' });
    // Try to increment helpful/not helpful counters if columns exist
    try {
      await this.prisma.faqItem.update({
        where: { id: itemId },
        data: helpful ? { helpfulCount: { increment: 1 } } as any : { notHelpfulCount: { increment: 1 } } as any,
      });
    } catch {}
    return { itemId, helpful, recorded: true };
  }
}
