export declare enum ReportCategoryDto {
    FRAUD = "FRAUD",
    FAKE_IDENTITY = "FAKE_IDENTITY",
    INAPPROPRIATE_CONTENT = "INAPPROPRIATE_CONTENT",
    TNC_VIOLATION = "TNC_VIOLATION",
    MONEY_LAUNDERING = "MONEY_LAUNDERING",
    SPAM = "SPAM",
    OTHER = "OTHER"
}
export declare class ReportUserSettingsDto {
    targetId: string;
    category: ReportCategoryDto;
    description: string;
    evidenceUrls?: string[];
    relatedOrderId?: string;
    relatedMessageId?: string;
}
