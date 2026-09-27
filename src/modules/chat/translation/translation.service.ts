import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatTranslationProvider, ChatTranslationResult } from './translation.provider';
import * as ErrorCodes from '../../../common/constants/error-codes';

/**
 * Batch 43 BE-CHAT: provider HTTP generik untuk terjemahan pesan.
 *
 * Murni digerakkan konfigurasi env (CHAT_TRANSLATION_PROVIDER=http,
 * CHAT_TRANSLATION_ENDPOINT, CHAT_TRANSLATION_API_KEY) — TIDAK ada credential
 * yang di-hardcode di kode. Kontrak request/response:
 *   POST {endpoint}  Authorization: Bearer <apiKey>   { text, targetLang }
 *   → 200 { translatedText: string, sourceLang?: string }
 * Bentuk respons alternatif yang juga diterima: { translation }, atau
 * { data: { translations: [{ translatedText }] } } (mirip Google Translate v2).
 */
class HttpChatTranslationProvider implements ChatTranslationProvider {
  readonly name = 'http';
  private readonly logger = new Logger(HttpChatTranslationProvider.name);

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string | null,
  ) {}

  async translate(text: string, targetLang: string): Promise<ChatTranslationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ text, targetLang }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`provider responded ${response.status}`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      const translatedText =
        pickString(body, 'translatedText') ??
        pickString(body, 'translation') ??
        pickNestedGoogle(body);
      if (!translatedText) {
        throw new Error('provider response missing translatedText');
      }
      const sourceLang = pickString(body, 'sourceLang') ?? pickString(body, 'detectedSourceLang');
      return { translatedText, ...(sourceLang ? { sourceLang } : {}) };
    } catch (error) {
      this.logger.warn(`Translation provider call failed: ${(error as Error)?.message ?? error}`);
      throw new HttpException(
        { code: 'TRANSLATION_PROVIDER_ERROR', message: 'Translation provider is unreachable' },
        HttpStatus.BAD_GATEWAY,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function pickString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function pickNestedGoogle(body: Record<string, unknown>): string | null {
  const data = body['data'];
  if (data && typeof data === 'object') {
    const translations = (data as Record<string, unknown>)['translations'];
    if (Array.isArray(translations) && translations.length > 0) {
      const first = translations[0] as Record<string, unknown>;
      return pickString(first, 'translatedText');
    }
  }
  return null;
}

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);
  private readonly provider: ChatTranslationProvider | null;

  constructor(private readonly configService: ConfigService) {
    const translation = this.configService.get<{ provider: string | null; apiKey: string | null; endpoint: string | null }>('chat.translation');
    const providerName = translation?.provider ?? null;
    const endpoint = translation?.endpoint ?? null;
    if (providerName === 'http' && endpoint) {
      this.provider = new HttpChatTranslationProvider(endpoint, translation?.apiKey ?? null);
      this.logger.log(`Chat translation provider enabled: http → ${endpoint}`);
    } else {
      this.provider = null;
      if (providerName) {
        this.logger.warn(`Unknown CHAT_TRANSLATION_PROVIDER="${providerName}" — translation disabled (fail closed)`);
      }
    }
  }

  /** true bila ada provider terjemahan yang terkonfigurasi. */
  isConfigured(): boolean {
    return this.provider !== null;
  }

  /**
   * Terjemahkan teks. Fail closed dengan 501 TRANSLATION_NOT_CONFIGURED bila
   * provider belum dikonfigurasi — sesuai spesifikasi batch 43.
   */
  async translate(text: string, targetLang: string): Promise<ChatTranslationResult> {
    if (!this.provider) {
      throw new HttpException(
        { code: ErrorCodes.TRANSLATION_NOT_CONFIGURED, message: 'Translation provider is not configured' },
        HttpStatus.NOT_IMPLEMENTED,
      );
    }
    return this.provider.translate(text, targetLang);
  }
}
