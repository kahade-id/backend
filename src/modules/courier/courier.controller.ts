/**
 * courier.controller.ts — endpoint user /v1/courier/* (G228–G246).
 *
 * Semua endpoint butuh JWT user (kecuali unduhan label via signed URL).
 */
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { createReadStream } from 'fs';
import { Throttle } from '@nestjs/throttler';
import { CourierService, MaskedShipment } from './courier.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { LocalStorageService } from '../upload/local-storage.service';
import {
  BookShipmentDto,
  CreateShipmentDto,
  ManualResiDto,
  QuoteRequestDto,
  RequestRefundDto,
  VoidShipmentDto,
} from './dto/courier.dto';
import { ShippingQuote } from './providers/courier-provider.interface';

@ApiTags('courier')
@ApiBearerAuth('access-token')
@Controller('courier')
export class CourierController {
  constructor(
    private readonly courierService: CourierService,
    private readonly storage: LocalStorageService,
  ) {}

  @Get('catalog')
  @ApiOperation({ summary: 'Katalog kurir & layanan yang tersedia' })
  async getCatalog(): Promise<unknown> {
    return this.courierService.getCatalog();
  }

  @Post('quotes')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Estimasi ongkir & ETA + perbandingan layanan (G228/G230)' })
  async getQuotes(
    @CurrentUser('sub') _userId: string,
    @Body() dto: QuoteRequestDto,
  ): Promise<{ quotes: ShippingQuote[]; sortedBy: string }> {
    return this.courierService.getQuotes(dto);
  }

  @Post('shipments')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Buat draf pengiriman untuk order (G232/G243)' })
  async createShipment(
    @CurrentUser('sub') userId: string,
    @Body() dto: CreateShipmentDto,
  ): Promise<MaskedShipment> {
    return this.courierService.createShipment(userId, dto);
  }

  @Get('shipments/by-order/:orderId')
  @ApiOperation({ summary: 'Pengiriman untuk sebuah order' })
  async getShipmentByOrder(
    @CurrentUser('sub') userId: string,
    @Param('orderId') orderId: string,
  ): Promise<MaskedShipment | null> {
    return this.courierService.getShipmentByOrder(userId, orderId);
  }

  @Get('shipments/:id')
  @ApiOperation({ summary: 'Detail pengiriman (alamat termasking, G238)' })
  async getShipment(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<MaskedShipment> {
    return this.courierService.getShipment(userId, id);
  }

  @Get('shipments/:id/tracking')
  @ApiOperation({ summary: 'Timeline tracking (G236/G238)' })
  async getTracking(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<unknown[]> {
    return this.courierService.listEvents(userId, id);
  }

  @Post('shipments/:id/book')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Booking pickup + label dari layar order (G232)' })
  async bookShipment(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: BookShipmentDto,
  ): Promise<MaskedShipment> {
    return this.courierService.bookShipment(userId, id, dto);
  }

  @Post('shipments/:id/refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Refresh tracking manual / pull (G239)' })
  async refreshTracking(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<{ status: string; events: number; timeout: boolean }> {
    return this.courierService.refreshTracking(userId, id);
  }

  @Post('shipments/:id/void')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Batalkan label tersinkron ke provider (G242)' })
  async voidShipment(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: VoidShipmentDto,
  ): Promise<MaskedShipment> {
    return this.courierService.voidShipment(userId, id, dto);
  }

  @Post('shipments/:id/manual-resi')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Fallback resi manual bila provider nonaktif (G241)' })
  async setManualResi(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: ManualResiDto,
  ): Promise<MaskedShipment> {
    return this.courierService.setManualResi(userId, id, dto);
  }

  @Get('shipments/:id/label')
  @ApiOperation({ summary: 'Signed URL unduhan label (G234)' })
  async getLabelUrl(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
  ): Promise<{ url: string; expiresAt: string }> {
    return this.courierService.getLabelDownloadUrl(userId, id);
  }

  /**
   * Berkas label — PUBLIK secara rute, tetapi dilindungi signature HMAC +
   * expiry (G234). Tanpa sig valid → 403 (fail-closed).
   */
  @Public()
  @Get('shipments/:id/label/file')
  @ApiOperation({ summary: 'Unduh berkas label (signed URL)' })
  async downloadLabel(
    @Param('id') id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { fileKey, mimeType } = await this.courierService.resolveLabelFile(id, exp, sig);
    const absPath = this.storage.resolvePath(fileKey);
    res.set({
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="label-${id}.pdf"`,
      'Cache-Control': 'private, max-age=60',
    });
    return new StreamableFile(createReadStream(absPath));
  }

  @Post('shipments/:id/refunds')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Ajukan refund ongkir (G247)' })
  async requestRefund(
    @CurrentUser('sub') userId: string,
    @Param('id') id: string,
    @Body() dto: RequestRefundDto,
  ): Promise<unknown> {
    return this.courierService.requestRefund(userId, id, dto);
  }
}
