import { Controller, Get, Post, Param, Query } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ParseSlugPipe } from '../../common/pipes/parse-slug.pipe';
import { ParseQueryStringPipe } from '../../common/pipes/parse-query-string.pipe';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { HelpCenterService } from './help-center.service';
import { Public } from '../../common/decorators/public.decorator';

@ApiTags('help-center')
@Controller('help-center')
export class HelpCenterController {
  constructor(private helpCenterService: HelpCenterService) {}

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('categories')
  async getCategories(@Query('lang', new ParseQueryStringPipe('lang', 5)) lang?: string) {
    return this.helpCenterService.getCategories(lang || 'id');
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Get('categories/:slug')
  async getCategoryBySlug(@Param('slug', ParseSlugPipe) slug: string, @Query('lang', new ParseQueryStringPipe('lang', 5)) lang?: string) {
    return this.helpCenterService.getCategoryBySlug(slug, lang || 'id');
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Get('search')
  async searchFaq(@Query('q', new ParseQueryStringPipe('q', 100)) query: string, @Query('lang', new ParseQueryStringPipe('lang', 5)) lang?: string) {
    return this.helpCenterService.searchFaq(query || '', lang || 'id');
  }

  @Public()
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @Post('items/:id/view')
  async trackView(@Param('id', ParseIdPipe) id: string) {
    return this.helpCenterService.trackView(id);
  }
}
