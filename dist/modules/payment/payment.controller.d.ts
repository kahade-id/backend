import { Request } from 'express';
import { PaymentService } from './payment.service';
export declare class PaymentController {
    private paymentService;
    constructor(paymentService: PaymentService);
    midtransWebhook(body: Record<string, unknown>, req: Request): Promise<{
        message: string;
    }>;
}
