import { VoucherType, VoucherApplicability } from '@prisma/client';
export declare class CreateVoucherDto {
    code: string;
    name: string;
    description?: string;
    voucherType: VoucherType;
    discountAmount?: number;
    discountPercent?: number;
    maxDiscountAmount?: number;
    maxUsageTotal?: number;
    maxUsagePerUser?: number;
    validFrom: string;
    validUntil: string;
    minOrderValue?: number;
    applicableTo?: VoucherApplicability;
}
