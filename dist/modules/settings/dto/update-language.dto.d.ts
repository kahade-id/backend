export declare const SUPPORTED_LANGUAGES: readonly ["id", "en"];
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
export declare class UpdateLanguageDto {
    language: SupportedLanguage;
}
