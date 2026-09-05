import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';
import { Throttle } from '@nestjs/throttler';
import { ParseQueryStringPipe } from '../../common/pipes/parse-query-string.pipe';

const ALLOWED_SEARCH_TYPES = new Set(['users', 'orders', 'transactions']);

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
    return this.searchService.search(userId, q, typeArray, limit);
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
}
