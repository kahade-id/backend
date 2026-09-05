import { Writable } from 'stream';
import { PrismaService } from '../../prisma/prisma.service';
export declare class WalletExportService {
    private prisma;
    constructor(prisma: PrismaService);
    private buildWhere;
    private fetchTransactionsCursor;
    private formatCsvRow;
    streamTransactionsCsv(userId: string, output: Writable, startDate?: string, endDate?: string, types?: string[]): Promise<boolean>;
    exportTransactionsCsv(userId: string, startDate?: string, endDate?: string, types?: string[]): Promise<string>;
    exportTransactionsXlsx(userId: string, startDate?: string, endDate?: string, types?: string[]): Promise<Buffer>;
    exportTransactionsHtml(userId: string, startDate?: string, endDate?: string): Promise<string>;
}
