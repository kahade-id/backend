"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HelpCenterService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let HelpCenterService = class HelpCenterService {
    constructor(prisma) {
        this.prisma = prisma;
    }
    normalizeLanguage(lang) {
        return lang.trim().toLowerCase() === 'en' ? 'en' : 'id';
    }
    async getCategories(lang = 'id') {
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
    async getCategoryBySlug(slug, lang = 'id') {
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
        if (!cat)
            throw new common_1.NotFoundException({ code: 'FAQ_NOT_FOUND', message: 'FAQ category not found' });
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
    async searchFaq(query, lang = 'id') {
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
    async trackView(itemId) {
        const item = await this.prisma.faqItem.findFirst({
            where: { id: itemId, isActive: true, category: { isActive: true } },
            select: { id: true },
        });
        if (!item) {
            throw new common_1.NotFoundException({ code: 'FAQ_ITEM_NOT_FOUND', message: 'FAQ item not found' });
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
    async adminCreateCategory(dto) {
        return this.prisma.faqCategory.create({ data: dto });
    }
    async adminUpdateCategory(id, dto) {
        return this.prisma.faqCategory.update({ where: { id }, data: dto });
    }
    async adminDeleteCategory(id) {
        await this.prisma.faqCategory.delete({ where: { id } });
        return { message: 'Category deleted' };
    }
    async adminCreateItem(dto) {
        return this.prisma.faqItem.create({ data: dto });
    }
    async adminUpdateItem(id, dto) {
        return this.prisma.faqItem.update({ where: { id }, data: dto });
    }
    async adminDeleteItem(id) {
        await this.prisma.faqItem.delete({ where: { id } });
        return { message: 'FAQ item deleted' };
    }
};
exports.HelpCenterService = HelpCenterService;
exports.HelpCenterService = HelpCenterService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], HelpCenterService);
