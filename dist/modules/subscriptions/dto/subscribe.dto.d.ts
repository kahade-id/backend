import { SubscriptionPlan, PaymentMethod } from '@prisma/client';
export declare class SubscribeDto {
    plan: SubscriptionPlan;
    pin: string;
    paymentMethod?: PaymentMethod;
}
export declare class RenewDto {
    pin: string;
}
