import { BankAccountsService } from './bank-accounts.service';
import { AddBankAccountDto } from './dto/add-bank-account.dto';
import { UserJwtPayload } from '../../common/types/jwt-payload.types';
export declare class BankAccountsController {
    private readonly service;
    constructor(service: BankAccountsService);
    list(user: UserJwtPayload): Promise<{
        bankAccounts: Array<Record<string, unknown>>;
    }>;
    add(user: UserJwtPayload, dto: AddBankAccountDto): Promise<Record<string, unknown>>;
    setPrimary(user: UserJwtPayload, id: string): Promise<Record<string, unknown>>;
    delete(user: UserJwtPayload, id: string): Promise<{
        message: string;
    }>;
}
