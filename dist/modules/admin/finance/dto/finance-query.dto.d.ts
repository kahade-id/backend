import { WalletTransactionType, WalletTransactionStatus } from '@prisma/client';
import { PaginationDto } from '../../../../common/dto/pagination.dto';
export declare class FinanceTransactionQueryDto extends PaginationDto {
    type?: WalletTransactionType;
    status?: WalletTransactionStatus;
    startDate: string;
    endDate: string;
}
