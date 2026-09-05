export declare class CreateTemplateDto {
    name: string;
    title: string;
    description?: string;
    orderType: 'PHYSICAL_GOODS' | 'DIGITAL_GOODS' | 'SERVICE' | 'OTHER';
    orderValue: number;
    feeResponsibility?: 'BUYER' | 'SELLER' | 'SPLIT';
    deliveryDeadlineDays?: number;
    isDefault?: boolean;
}
export declare class UpdateTemplateDto {
    name?: string;
    title?: string;
    description?: string;
    orderType?: 'PHYSICAL_GOODS' | 'DIGITAL_GOODS' | 'SERVICE' | 'OTHER';
    orderValue?: number;
    feeResponsibility?: 'BUYER' | 'SELLER' | 'SPLIT';
    deliveryDeadlineDays?: number;
    isDefault?: boolean;
}
