import { FeeResponsibility, OrderType } from '@prisma/client';
export declare class CreateOrderDto {
    role: 'BUYER' | 'SELLER';
    counterpartUsername: string;
    title: string;
    description: string;
    orderType: OrderType;
    orderValue: number;
    deliveryDeadlineDays: number;
    feeResponsibility: FeeResponsibility;
    voucherCode?: string;
}
