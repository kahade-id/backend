import { Controller, Delete, Get, Param, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { Throttle } from '@nestjs/throttler';
import { ParseQueryStringPipe } from '../../common/pipes/parse-query-string.pipe';

const ALLOWED_SEARCH_TYPES = new Set(['users', 'orders', 'transactions', 'showcase', 'help-center']);

function parseLimit(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new BadRequestException({ code: 'SEARCH_INVALID_LIMIT', message: 'Search limit must be a whole number' });
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException({ code: 'SEARCH_INVALID_LIMIT', message: `Search limit must be between 1 and ${max}` });
  }
  return parsed;
}

@ApiTags('Search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private searchService: SearchService) {}

  @Get()
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Global search across users, orders, and transactions' })
  async search(
    @CurrentUser('sub') userId: string,
    @Query('q', new ParseQueryStringPipe('q', 200)) query: string,
    @Query('types', new ParseQueryStringPipe('types', 100)) types?: string,
    @Query('limit') limitParam?: string,
    @Query('location', new ParseQueryStringPipe('location', 100)) location?: string,
  ): Promise<object> {
    const q = (query || '').trim();
    if (q.length > 0 && q.length < 2) {
      throw new BadRequestException({ code: 'SEARCH_QUERY_TOO_SHORT', message: 'Search query must be at least 2 characters' });
    }
    const limit = parseLimit(limitParam, 5, 50);
    let typeArray: string[] | undefined;
    if (types !== undefined) {
      const requestedTypes = types.split(',').map((t) => t.trim()).filter(Boolean);
      if (requestedTypes.length === 0 || requestedTypes.some((type) => !ALLOWED_SEARCH_TYPES.has(type))) {
        throw new BadRequestException({ code: 'SEARCH_INVALID_TYPES', message: 'Invalid search types' });
      }
      typeArray = Array.from(new Set(requestedTypes));
    }
    // Filter lokasi etalase (opsional): cocokkan free-text users.address milik
    // owner (case-insensitive). Hanya dipakai untuk jenis `showcase`.
    const locationFilter = (location ?? '').trim() || undefined;
    return this.searchService.search(userId, q, typeArray, limit, locationFilter);
  }

  @Get('suggestions')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Get search autocomplete suggestions' })
  async suggestions(
    @CurrentUser('sub') userId: string,
    @Query('q', new ParseQueryStringPipe('q', 200)) query: string,
    @Query('limit') limitParam?: string,
  ): Promise<object> {
    const q = (query || '').trim();
    if (q.length > 0 && q.length < 2) {
      return { suggestions: [] };
    }
    const limit = parseLimit(limitParam, 6, 20);
    return this.searchService.suggestions(userId, q, limit);
  }

  @Get('history')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Get search history (13.2)' })
  async history(@CurrentUser('sub') userId: string): Promise<object> {
    return this.searchService.getSearchHistory(userId);
  }

  @Delete('history')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Clear search history' })
  async clearHistory(@CurrentUser('sub') userId: string): Promise<object> {
    return this.searchService.clearSearchHistory(userId);
  }

  /**
   * BE-IMP (item 75): hapus satu entri riwayat pencarian.
   *
   * `:id` = teks query yang di-URL-encode (identitas item di Redis list).
   * Contoh: `DELETE /v1/search/history/kopi%20susu` menghapus "kopi susu".
   */
  @Delete('history/:id')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Delete one search history entry (13.2)' })
  async deleteHistoryItem(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<object> {
    const query = (id ?? '').trim();
    if (!query || query.length > 200) {
      throw new BadRequestException({ code: 'SEARCH_HISTORY_INVALID', message: 'Invalid search history entry' });
    }
    return this.searchService.removeSearchHistoryItem(userId, query);
  }

  /**
   * @deprecated DC-017 (audit Discovery 2026-09-26): GET untuk operasi mutasi
   * melanggar semantik REST. Alias backward-compat untuk klien lama — gunakan
   * `DELETE /v1/search/history`.
   */
  @Get('history/clear')
  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: '[DEPRECATED] Clear search history — use DELETE /v1/search/history' })
  async clearHistoryLegacy(@CurrentUser('sub') userId: string): Promise<object> {
    return this.searchService.clearSearchHistory(userId);
  }
}
