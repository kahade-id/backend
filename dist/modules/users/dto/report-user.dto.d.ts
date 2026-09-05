import { ReportCategory } from '@prisma/client';
export declare class ReportUserDto {
    category: ReportCategory;
    description: string;
    evidenceUrls?: string[];
    relatedOrderId?: string;
}
