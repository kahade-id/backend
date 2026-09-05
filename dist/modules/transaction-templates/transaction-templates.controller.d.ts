import { TransactionTemplatesService } from './transaction-templates.service';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
export declare class TransactionTemplatesController {
    private templatesService;
    constructor(templatesService: TransactionTemplatesService);
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
    getTemplate(userId: string, id: string): Promise<{
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
    updateTemplate(userId: string, id: string, dto: UpdateTemplateDto): Promise<{
        message: string;
    }>;
    deleteTemplate(userId: string, id: string): Promise<{
        message: string;
    }>;
}
