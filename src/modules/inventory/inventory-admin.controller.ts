/**
 * inventory-admin.controller.ts — /v1/admin/inventory (G266/G267/G272).
 *
 * Moderasi produk TERPISAH dari moderasi showcase (G272), daftar produk,
 * riwayat mutasi lintas seller, dan adjustment oleh admin (alasan wajib).
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminRoute } from '../../common/decorators/public.decorator';
import { AdminRoles } from '../../common/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../../common/decorators/current-admin.decorator';
import { JwtAdminGuard } from '../../common/guards/jwt-admin.guard';
import { AdminRolesGuard } from '../../common/guards/admin-roles.guard';
import { InventoryService } from './inventory.service';
import { AdjustStockDto, ModerateProductDto, MovementQueryDto } from './dto/inventory.dto';
import type { ProductStatus } from './inventory.types';

@ApiTags('admin-inventory')
@ApiBearerAuth('access-token')
@UseGuards(JwtAdminGuard, AdminRolesGuard)
@AdminRoles('SUPER_ADMIN', 'CUSTOMER_SUPPORT')
@AdminRoute()
@Controller('admin/inventory')
export class InventoryAdminController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('products')
  @ApiOperation({ summary: 'Daftar produk untuk moderasi (G272)' })
  async listProducts(
    @Query('moderationStatus') moderationStatus?: string,
    @Query('status') status?: ProductStatus,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.inventory.listProductsAdmin({
      moderationStatus,
      status,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('products/:id/moderate')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('SUPER_ADMIN', 'CUSTOMER_SUPPORT')
  @ApiOperation({ summary: 'Moderasi produk: APPROVED/REJECTED/FLAGGED (G272)' })
  async moderate(
    @CurrentAdmin('sub') adminId: string,
    @Param('id') id: string,
    @Body() dto: ModerateProductDto,
  ): Promise<unknown> {
    return this.inventory.moderateProduct(adminId, id, dto);
  }

  @Get('products/:id/moderation-events')
  @ApiOperation({ summary: 'Jejak audit moderasi produk (G272)' })
  async moderationEvents(@Param('id') id: string): Promise<unknown> {
    return { items: await this.inventory.getModerationEvents(id) };
  }

  @Get('movements')
  @AdminRoles('SUPER_ADMIN', 'CUSTOMER_SUPPORT', 'FINANCE_ADMIN')
  @ApiOperation({ summary: 'Riwayat mutasi stok lintas seller (G266)' })
  async movements(@Query() query: MovementQueryDto): Promise<unknown> {
    return this.inventory.getMovements({ isAdmin: true }, query);
  }

  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Penyesuaian stok oleh admin — alasan wajib (G267)' })
  async adminAdjust(
    @CurrentAdmin('sub') adminId: string,
    @Body() dto: AdjustStockDto,
  ): Promise<unknown> {
    return this.inventory.adjustStock({
      actorId: adminId,
      actorRole: 'ADMIN',
      sku: dto.sku,
      delta: dto.delta,
      reason: dto.reason,
    });
  }
}
