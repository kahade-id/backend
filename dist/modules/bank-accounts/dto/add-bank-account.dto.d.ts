import { BankCode } from '@prisma/client';
export declare class AddBankAccountDto {
    bankCode: BankCode;
    bankName: string;
    accountNumber: string;
    accountName: string;
}
