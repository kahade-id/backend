import { PrismaService } from '../../prisma/prisma.service';
export declare class ReceiptService {
    private prisma;
    constructor(prisma: PrismaService);
    generateReceiptHtml(orderId: string, userId: string): Promise<string>;
}
