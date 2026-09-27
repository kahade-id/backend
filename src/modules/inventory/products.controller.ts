/**
 * products.controller.ts — /v1/products (G251/G260/G262/G269–G271).
 *
 * Katalog publik (tanpa auth) + CRUD seller (JWT). Terpisah dari showcase:
 * produk = barang yang bisa dibeli (SKU + stok), showcase = konten sosial.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InventoryService } from './inventory.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import {
  CatalogQueryDto,
  CreateProductDto,
  CreateVariantDto,
  UpdateProductDto,
  UpdateProductStatusDto,
  UpdateVariantDto,
} from './dto/inventory.dto';
import type { ProductStatus } from './inventory.types';

@ApiTags('products')
@ApiBearerAuth('access-token')
@Controller('products')
export class ProductsController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  @Public()
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Katalog produk publik + filter kategori/harga/ketersediaan (G260)' })
  async catalog(@Query() query: CatalogQueryDto): Promise<unknown> {
    return this.inventory.listCatalog(query);
  }

  @Get('seller/mine')
  @ApiOperation({ summary: 'Daftar produk milik seller + pencarian SKU/varian (G270)' })
  async myProducts(
    @CurrentUser('sub') sellerId: string,
    @Query('search') search?: string,
    @Query('status') status?: ProductStatus,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<unknown> {
    return this.inventory.listSellerProducts(sellerId, {
      search,
      status,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Detail produk + tautan profil bisnis (G269)' })
  async detail(@Param('id') id: string): Promise<unknown> {
    return this.inventory.getProductDetail(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Seller membuat produk (G262)' })
  async create(
    @CurrentUser('sub') sellerId: string,
    @Body() dto: CreateProductDto,
  ): Promise<unknown> {
    return this.inventory.createProduct(sellerId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Seller mengedit produk (G262)' })
  async update(
    @CurrentUser('sub') sellerId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ): Promise<unknown> {
    return this.inventory.updateProduct(sellerId, id, dto);
  }

  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ubah status listing DRAFT/ACTIVE/OUT_OF_STOCK/ARCHIVED (G261)' })
  async setStatus(
    @CurrentUser('sub') sellerId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProductStatusDto,
  ): Promise<unknown> {
    return this.inventory.setProductStatus(sellerId, id, dto.status);
  }

  @Post(':id/variants')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Tambah varian (ukuran/warna) dengan kombinasi tervalidasi (G253)' })
  async createVariant(
    @CurrentUser('sub') sellerId: string,
    @Param('id') id: string,
    @Body() dto: CreateVariantDto,
  ): Promise<unknown> {
    return this.inventory.createVariant(sellerId, id, dto);
  }

  @Patch('variants/:variantId')
  @ApiOperation({ summary: 'Edit varian (harga/ambang/berat)' })
  async updateVariant(
    @CurrentUser('sub') sellerId: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantDto,
  ): Promise<unknown> {
    return this.inventory.updateVariant(sellerId, variantId, dto);
  }
}
