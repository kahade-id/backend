import { PrismaService } from '../../prisma/prisma.service';
import { CreateFaqCategoryDto, UpdateFaqCategoryDto, CreateFaqItemDto, UpdateFaqItemDto } from './dto';
export declare class HelpCenterService {
    private prisma;
    constructor(prisma: PrismaService);
    private normalizeLanguage;
    getCategories(lang?: string): Promise<{
        id: string;
        slug: string;
        name: string;
        description: string | null;
        icon: string | null;
        items: {
            id: string;
            question: string;
            answer: string;
            viewCount: number;
        }[];
    }[]>;
    getCategoryBySlug(slug: string, lang?: string): Promise<{
        id: string;
        slug: string;
        name: string;
        description: string | null;
        icon: string | null;
        items: {
            id: string;
            question: string;
            answer: string;
            viewCount: number;
        }[];
    }>;
    searchFaq(query: string, lang?: string): Promise<{
        id: string;
        question: string;
        answer: string;
        viewCount: number;
        category: {
            slug: string;
            name: string;
        };
    }[]>;
    trackView(itemId: string): Promise<void>;
    adminGetCategories(): Promise<({
        _count: {
            items: number;
        };
    } & {
        name: string;
        id: string;
        createdAt: Date;
        description: string | null;
        isActive: boolean;
        updatedAt: Date;
        sortOrder: number;
        slug: string;
        nameEn: string | null;
        descriptionEn: string | null;
        icon: string | null;
    })[]>;
    adminCreateCategory(dto: CreateFaqCategoryDto): Promise<{
        name: string;
        id: string;
        createdAt: Date;
        description: string | null;
        isActive: boolean;
        updatedAt: Date;
        sortOrder: number;
        slug: string;
        nameEn: string | null;
        descriptionEn: string | null;
        icon: string | null;
    }>;
    adminUpdateCategory(id: string, dto: UpdateFaqCategoryDto): Promise<{
        name: string;
        id: string;
        createdAt: Date;
        description: string | null;
        isActive: boolean;
        updatedAt: Date;
        sortOrder: number;
        slug: string;
        nameEn: string | null;
        descriptionEn: string | null;
        icon: string | null;
    }>;
    adminDeleteCategory(id: string): Promise<{
        message: string;
    }>;
    adminCreateItem(dto: CreateFaqItemDto): Promise<{
        id: string;
        createdAt: Date;
        isActive: boolean;
        updatedAt: Date;
        sortOrder: number;
        question: string;
        answer: string;
        categoryId: string;
        questionEn: string | null;
        answerEn: string | null;
        viewCount: number;
    }>;
    adminUpdateItem(id: string, dto: UpdateFaqItemDto): Promise<{
        id: string;
        createdAt: Date;
        isActive: boolean;
        updatedAt: Date;
        sortOrder: number;
        question: string;
        answer: string;
        categoryId: string;
        questionEn: string | null;
        answerEn: string | null;
        viewCount: number;
    }>;
    adminDeleteItem(id: string): Promise<{
        message: string;
    }>;
}
