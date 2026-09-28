import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import * as ErrorCodes from '../../../common/constants/error-codes';
import { RecordSearchDto } from '../dto/commerce.dto';

const MAX_KEYWORD_LEN = 80;
/** Pola yang mengindikasikan PII — keyword seperti ini ditolak, bukan disimpan. */
const PII_PATTERNS: RegExp[] = [
  /(\+?62|0)8\d{7,12}/, // nomor HP Indonesia
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, // email
  /\b\d{16}\b/, // NIK / nomor kartu
];

/**
 * BE-COMMERCE (2026-10-01) — item 6: agregat kata kunci pencarian TANPA PII.
 * Frontend memanggil POST /v1/commerce/trends/record setiap pencarian;
 * GET /v1/commerce/trends mengembalikan kata kunci terpopuler (publik).
 */
@Injectable()
export class SearchTrendsService {
  constructor(private prisma: PrismaService) {}

  /** Sanitasi keyword: lowercase, trim, tolak PII & keyword sampah. */
  static sanitizeKeyword(raw: string): string | null {
    const keyword = raw.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, MAX_KEYWORD_LEN);
    if (keyword.length < 2) return null;
    if (PII_PATTERNS.some((re) => re.test(keyword))) return null;
    // Tolak keyword yang seluruhnya angka/simbol (bukan pencarian bermakna).
    if (/^[^a-z\u00C0-\u024F\u1E00-\u1EFF]+$/u.test(keyword)) return null;
    return keyword;
  }

  async recordSearch(dto: RecordSearchDto): Promise<{ ok: true; recorded: boolean }> {
    const keyword = SearchTrendsService.sanitizeKeyword(dto.keyword);
    if (!keyword) return { ok: true, recorded: false };
    await this.prisma.searchKeyword.upsert({
      where: { keyword },
      create: { keyword, searchCount: 1, lastSearchedAt: new Date() },
      update: { searchCount: { increment: 1 }, lastSearchedAt: new Date() },
    });
    return { ok: true, recorded: true };
  }

  async getTrending(limit = 10): Promise<{ keyword: string; searchCount: number }[]> {
    const take = Math.min(Math.max(limit, 1), 50);
    const rows = await this.prisma.searchKeyword.findMany({
      orderBy: [{ searchCount: 'desc' }, { lastSearchedAt: 'desc' }],
      take,
      select: { keyword: true, searchCount: true },
    });
    return rows;
  }
}
