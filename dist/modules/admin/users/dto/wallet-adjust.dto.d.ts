export declare enum WalletAdjustType {
    CREDIT = "CREDIT",
    DEBIT = "DEBIT"
}
export declare class WalletAdjustDto {
    amount: number;
    type: WalletAdjustType;
    reason: string;
    idempotencyKey?: string;
}
