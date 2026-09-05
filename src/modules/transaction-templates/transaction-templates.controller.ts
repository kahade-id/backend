import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { TransactionTemplatesService } from './transaction-templates.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
import { UserThrottleGuard } from '../../common/guards/user-throttle.guard';

@ApiTags('transaction-templates')
@ApiBearerAuth('access-token')
@Throttle({ default: { ttl: 60000, limit: 30 } })
@Controller('transaction-templates')
export class TransactionTemplatesController {
  constructor(private templatesService: TransactionTemplatesService) {}

  @Get()
  async getMyTemplates(@CurrentUser('sub') userId: string) {
    return this.templatesService.getMyTemplates(userId);
  }

  @Get(':id')
  async getTemplate(@CurrentUser('sub') userId: string, @Param('id', ParseIdPipe) id: string) {
    return this.templatesService.getTemplate(userId, id);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Post()
  async createTemplate(@CurrentUser('sub') userId: string, @Body() dto: CreateTemplateDto) {
    return this.templatesService.createTemplate(userId, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @Put(':id')
  async updateTemplate(
    @CurrentUser('sub') userId: string,
    @Param('id', ParseIdPipe) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.templatesService.updateTemplate(userId, id, dto);
  }

  @UseGuards(UserThrottleGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @Delete(':id')
  async deleteTemplate(@CurrentUser('sub') userId: string, @Param('id', ParseIdPipe) id: string) {
    return this.templatesService.deleteTemplate(userId, id);
  }
}
