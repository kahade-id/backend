import { PrismaService } from '../../prisma/prisma.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
export declare class TransactionTemplatesService {
    private prisma;
    constructor(prisma: PrismaService);
    getMyTemplates(userId: string): Promise<{
        templates: {
            id: string;
            name: string;
            title: string;
            description: string | null;
            orderType: import("@prisma/client").$Enums.OrderType;
            orderValue: number;
            feeResponsibility: import("@prisma/client").$Enums.FeeResponsibility;
            deliveryDeadlineDays: number;
            isDefault: boolean;
            usageCount: number;
            lastUsedAt: Date | null;
            createdAt: Date;
        }[];
        total: number;
    }>;
    getTemplate(userId: string, templateId: string): Promise<{
        id: string;
        name: string;
        title: string;
        description: string | null;
        orderType: import("@prisma/client").$Enums.OrderType;
        orderValue: number;
        feeResponsibility: import("@prisma/client").$Enums.FeeResponsibility;
        deliveryDeadlineDays: number;
        isDefault: boolean;
        usageCount: number;
        lastUsedAt: Date | null;
        createdAt: Date;
    }>;
    createTemplate(userId: string, dto: CreateTemplateDto): Promise<{
        id: string;
        name: string;
        message: string;
    }>;
    updateTemplate(userId: string, templateId: string, dto: UpdateTemplateDto): Promise<{
        message: string;
    }>;
    deleteTemplate(userId: string, templateId: string): Promise<{
        message: string;
    }>;
    recordUsage(templateId: string): Promise<void>;
}
