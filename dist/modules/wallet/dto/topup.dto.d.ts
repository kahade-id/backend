import { PaymentMethod } from '@prisma/client';
export declare class TopupDto {
    amount: number;
    method: Exclude<PaymentMethod, 'KAHADE_WALLET'>;
    cardToken?: string;
    pin?: string;
}
