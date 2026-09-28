/**
 * Batch 43 BE-CHAT: provider interface terjemahan pesan.
 *
 * Implementasi konkret (mis. HTTP ke layanan pihak ketiga) di-resolve oleh
 * TranslationService berdasarkan konfigurasi env. Bila provider belum
 * dikonfigurasi, service fail-closed (501 TRANSLATION_NOT_CONFIGURED) —
 * tidak ada fallback diam-diam.
 */
export interface ChatTranslationResult {
  translatedText: string;
  /** Kode bahasa sumber bila provider melaporkannya (mis. "id"). */
  sourceLang?: string;
}

export interface ChatTranslationProvider {
  /** Nama provider, mis. "http". */
  readonly name: string;
  translate(text: string, targetLang: string): Promise<ChatTranslationResult>;
}
