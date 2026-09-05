export declare enum UploadPurpose {
    KYC_KTP = "KYC_KTP",
    KYC_SELFIE = "KYC_SELFIE",
    AVATAR = "AVATAR",
    CHAT_ATTACHMENT = "CHAT_ATTACHMENT",
    DISPUTE_EVIDENCE = "DISPUTE_EVIDENCE",
    REPORT_EVIDENCE = "REPORT_EVIDENCE",
    DELIVERY_PROOF = "DELIVERY_PROOF"
}
export declare class PresignedUrlDto {
    purpose: UploadPurpose;
    fileName: string;
    contentType: string;
    fileSize: number;
}
