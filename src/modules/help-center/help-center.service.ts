import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateFaqCategoryDto, UpdateFaqCategoryDto, CreateFaqItemDto, UpdateFaqItemDto } from './dto';

@Injectable()
export class HelpCenterService {
  constructor(private prisma: PrismaService) {}

  private normalizeLanguage(lang: string): 'id' | 'en' {
    return lang.trim().toLowerCase() === 'en' ? 'en' : 'id';
  }

  async getCategories(lang: string = 'id') {
    const language = this.normalizeLanguage(lang);
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

    return categories.map((cat) => ({
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
          { question: { contains: normalizedQuery, mode: 'insensitive' } },
          { questionEn: { contains: normalizedQuery, mode: 'insensitive' } },
          { answer: { contains: normalizedQuery, mode: 'insensitive' } },
          { answerEn: { contains: normalizedQuery, mode: 'insensitive' } },
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
    return this.prisma.faqCategory.create({ data: dto });
  }

  async adminUpdateCategory(id: string, dto: UpdateFaqCategoryDto) {
    return this.prisma.faqCategory.update({ where: { id }, data: dto });
  }

  async adminDeleteCategory(id: string) {
    await this.prisma.faqCategory.delete({ where: { id } });
    return { message: 'Category deleted' };
  }

  async adminCreateItem(dto: CreateFaqItemDto) {
    return this.prisma.faqItem.create({ data: dto });
  }

  async adminUpdateItem(id: string, dto: UpdateFaqItemDto) {
    return this.prisma.faqItem.update({ where: { id }, data: dto });
  }

  async adminDeleteItem(id: string) {
    await this.prisma.faqItem.delete({ where: { id } });
    return { message: 'FAQ item deleted' };
  }
}
