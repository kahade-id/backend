/**
 * inventory.controller.ts — /v1/inventory (G254–G259, G263–G267, G274).
 *
 * Operasi stok milik seller (JWT): penyesuaian beraudit, riwayat mutasi,
 * stok menipis, impor/ekspor CSV, bulk update, validasi pre-checkout.
 */
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { InventoryService } from './inventory.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import {
  AdjustStockDto,
  AttachOrderLinesDto,
  BulkUpdateDto,
  MovementQueryDto,
  PreCheckoutDto,
} from './dto/inventory.dto';
import { IsString, IsNotEmpty } from 'class-validator';

class ImportCsvDto {
  @IsString({ message: 'CSV wajib berupa teks.' })
  @IsNotEmpty({ message: 'Isi CSV tidak boleh kosong.' })
  csv!: string;
}

@ApiTags('inventory')
@ApiBearerAuth('access-token')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('pre-checkout')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Validasi server harga & stok terkini + kebijakan sebelum checkout (G274)' })
  async preCheckout(@Body() dto: PreCheckoutDto): Promise<unknown> {
    return this.inventory.validatePreCheckout(dto);
  }

  @Post('order-lines')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Lampirkan order lines (snapshot qty + harga satuan) ke order (G259)' })
  async attachOrderLines(
    @CurrentUser('sub') _userId: string,
    @Body() dto: AttachOrderLinesDto,
  ): Promise<unknown> {
    return this.inventory.attachOrderLines(dto.orderDbId, dto);
  }

  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 60 } })
  @ApiOperation({ summary: 'Penyesuaian stok manual — alasan wajib, hanya pemilik (G267)' })
  async adjust(
    @CurrentUser('sub') sellerId: string,
    @Body() dto: AdjustStockDto,
  ): Promise<unknown> {
    return this.inventory.adjustStock({
      actorId: sellerId,
      actorRole: 'SELLER',
      sku: dto.sku,
      delta: dto.delta,
      reason: dto.reason,
    });
  }

  @Get('movements')
  @ApiOperation({ summary: 'Riwayat mutasi stok beraudit milik seller (G266)' })
  async movements(
    @CurrentUser('sub') sellerId: string,
    @Query() query: MovementQueryDto,
  ): Promise<unknown> {
    return this.inventory.getMovements({ sellerId, isAdmin: false }, query);
  }

  @Get('low-stock')
  @ApiOperation({ summary: 'Peringatan stok menipis per SKU (G264)' })
  async lowStock(@CurrentUser('sub') sellerId: string): Promise<unknown> {
    return { items: await this.inventory.getLowStock(sellerId) };
  }

  @Post('bulk-update')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Bulk update harga/stok dengan pratinjau dry-run (G265)' })
  async bulkUpdate(
    @CurrentUser('sub') sellerId: string,
    @Body() dto: BulkUpdateDto,
  ): Promise<unknown> {
    return this.inventory.bulkUpdate(sellerId, dto);
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Impor CSV stok dengan validasi per baris + laporan error (G263)' })
  async importCsv(
    @CurrentUser('sub') sellerId: string,
    @Body() dto: ImportCsvDto,
  ): Promise<unknown> {
    return this.inventory.importCsv(sellerId, dto.csv);
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="stok-produk.csv"')
  @ApiOperation({ summary: 'Ekspor CSV stok produk milik seller (G263)' })
  async exportCsv(
    @CurrentUser('sub') sellerId: string,
    @Res() res: Response,
  ): Promise<void> {
    const csv = await this.inventory.exportCsv(sellerId);
    res.send(`\uFEFF${csv}`);
  }
}
