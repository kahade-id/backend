export declare class DisputeDecisionDto {
    decision: 'FULL_BUYER' | 'FULL_SELLER' | 'SPLIT';
    decisionNotes: string;
    buyerPercent?: number;
    sellerPercent?: number;
}
export declare function validateSplitPercents(dto: DisputeDecisionDto): void;
