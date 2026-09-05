import { FeeResponsibility, OrderType } from '@prisma/client';
export declare class CreateOrderLinkDto {
    role: 'BUYER' | 'SELLER';
    title: string;
    description: string;
    orderType: OrderType;
    orderValue: number;
    deliveryDeadlineDays: number;
    feeResponsibility: FeeResponsibility;
    counterpartUsername?: string;
}
