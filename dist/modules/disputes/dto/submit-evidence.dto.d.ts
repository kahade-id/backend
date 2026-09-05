export declare const ALLOWED_EVIDENCE_MIME_TYPES: readonly ["image/jpeg", "image/png", "image/webp", "application/pdf"];
export declare class SubmitEvidenceDto {
    description: string;
    fileUrls: string[];
    fileTypes: string[];
}
