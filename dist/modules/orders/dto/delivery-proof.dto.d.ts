export declare class SubmitDeliveryProofDto {
    description: string;
    fileUrls?: string[];
    linkUrls?: string[];
}
export declare class ConfirmDeliveryDto {
    proofId?: string;
}
export declare class RejectDeliveryDto {
    note: string;
    proofId?: string;
}
