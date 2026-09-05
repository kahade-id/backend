import { PrismaService } from '../../prisma/prisma.service';
export declare class InvoiceService {
    private prisma;
    constructor(prisma: PrismaService);
    getInvoiceData(orderId: string, userId: string): Promise<object>;
}
