/**
 * courier.service.ts — logika bisnis integrasi kurir (G226–G250).
 *
 * Batasan desain:
 * - Modul logistik TERPISAH: tidak mengubah perilaku order/wallet existing.
 *   Satu-satunya tulis ke tabel orders adalah penyalinan trackingNumber /
 *   courierName saat booking/manual-resi — field yang sama ditulis alur
 *   manual E10, supaya UI buyer yang membaca order.trackingNumber tetap jalan.
 * - Secret HANYA via env/config. Tidak ada kredensial provider nyata.
 * - Provider timeout → status UNKNOWN (G240), jangan mengarang status.
 */
import { Injectable, Logger, BadRequestException, NotFoundException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual, randomUUID } from 'crypto';
import {
  CourierBillStatus,
  OrderType,
  Prisma,
  ShipmentBookingState,
  ShipmentMode,
  ShipmentStatus,
  ShippingCostBearer,
  ShippingRefundStatus,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LocalStorageService } from '../upload/local-storage.service';
import { NotificationQueueService } from '../queue/notification-queue.service';
import { NotificationType } from '@prisma/client';
import * as ErrorCodes from '../../common/constants/error-codes';
import { CourierRegistry } from './providers/courier-registry';
import { CourierConfigService, KNOWN_COURIER_CODES } from './courier.config';
import {
  CourierAddress,
  CourierTimeoutError,
  ProviderTrackingEvent,
  ShippingQuote,
} from './providers/courier-provider.interface';
import { maskLocation } from './providers/mock-courier.provider';
import {
  ApproveShippingRefundDto,
  BookShipmentDto,
  CreateShipmentDto,
  DecideRefundDto,
  ManualResiDto,
  QuoteRequestDto,
  RequestRefundDto,
  UpdateAdminProviderFlagDto,
  VoidShipmentDto,
} from './dto/courier.dto';

/**
 * SYS-B-501: validasi nominal refund ongkir — fail-closed.
 *
 * cap = costBase − refundedAmount: total refund tidak boleh melebihi biaya
 * ongkir yang benar-benar terjadi (aktual bila sudah ada, kalau belum maka
 * estimasi). Seluruh nominal dalam BigInt agar presisi aman.
 *
 * Throw BadRequestException (400) bila amount ≤ 0 atau melebihi sisa.
 */
export function validateShippingRefundAmount(
  shipment: { costBase: bigint; refundedAmount: bigint },
  amount: bigint,
): void {
  if (amount <= 0n) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      message: 'Nominal refund harus lebih dari 0',
    });
  }
  const remaining = shipment.costBase - shipment.refundedAmount;
  if (amount > remaining) {
    throw new BadRequestException({
      code: ErrorCodes.VALIDATION_ERROR,
      message: `Nominal refund (${amount}) melebihi sisa biaya yang bisa di-refund (${remaining})`,
    });
  }
}

// ---------------------------------------------------------------------------
// Normalisasi event provider → status internal (G236)
// ---------------------------------------------------------------------------

const RAW_STATUS_MAP: Array<{ test: RegExp; status: ShipmentStatus }> = [
  { test: /^(delivered|received|pod)$/i, status: ShipmentStatus.DELIVERED },
  { test: /^(returned|rto|return_to_sender|retur)$/i, status: ShipmentStatus.RETURNED },
  { test: /(out.for.delivery|with.courier|on.delivery|sedang.diantar|kurir)/i, status: ShipmentStatus.OUT_FOR_DELIVERY },
  { test: /(in.transit|on.process|sorting|departed|arrived|transit|diteruskan)/i, status: ShipmentStatus.IN_TRANSIT },
  { test: /^(picked.?up|pickup|collected|dijemput)$/i, status: ShipmentStatus.PICKED_UP },
  { test: /(exception|failed|gagal|kendala|hold|damaged|lost|hilang)/i, status: ShipmentStatus.EXCEPTION },
  { test: /^(created|label.created|awb.created|booked|dibuat)$/i, status: ShipmentStatus.CREATED },
];

/** Urutan progres — status tidak boleh turun kecuali dari UNKNOWN/EXCEPTION. */
const STATUS_RANK: Record<ShipmentStatus, number> = {
  [ShipmentStatus.UNKNOWN]: 0,
  [ShipmentStatus.CREATED]: 1,
  [ShipmentStatus.PICKED_UP]: 2,
  [ShipmentStatus.EXCEPTION]: 2,
  [ShipmentStatus.IN_TRANSIT]: 3,
  [ShipmentStatus.OUT_FOR_DELIVERY]: 4,
  [ShipmentStatus.DELIVERED]: 5,
  [ShipmentStatus.RETURNED]: 5,
};

const TERMINAL_STATUSES: Set<ShipmentStatus> = new Set([ShipmentStatus.DELIVERED, ShipmentStatus.RETURNED]);

export function normalizeRawStatus(raw: string): { status: ShipmentStatus; known: boolean } {
  const cleaned = (raw ?? '').trim();
  for (const { test, status } of RAW_STATUS_MAP) {
    if (test.test(cleaned)) return { status, known: true };
  }
  return { status: ShipmentStatus.UNKNOWN, known: false };
}

/** Kode pos Indonesia → kode wilayah kasar untuk feature flag per wilayah (G249). */
export function regionForPostalCode(postalCode: string): string {
  const first = postalCode.charAt(0);
  const map: Record<string, string> = {
    '1': 'ID-JKT',
    '2': 'ID-SUM',
    '3': 'ID-SUM',
    '4': 'ID-JABAR',
    '5': 'ID-JATENG',
    '6': 'ID-JATIM',
    '7': 'ID-KAL',
    '8': 'ID-BALI-NUSA',
    '9': 'ID-SUL-PAPUA',
  };
  return map[first] ?? '*';
}

const LABEL_URL_TTL_SECONDS = 300; // 5 menit (G234: expiry singkat)
const STALE_EVENT_THRESHOLD_HOURS = 48; // tracking dianggap macet (G247)

export interface MaskedShipment {
  id: string;
  orderId: string;
  providerCode: string;
  serviceCode: string | null;
  serviceName: string | null;
  mode: ShipmentMode;
  bookingState: ShipmentBookingState;
  status: ShipmentStatus;
  trackingNumber: string | null;
  costBearer: ShippingCostBearer;
  estimatedCost: string;
  actualCost: string | null;
  currency: string;
  etaMinDays: number | null;
  etaMaxDays: number | null;
  slaDueAt: Date | null;
  slaBreached: boolean;
  isManual: boolean;
  manualCourierName: string | null;
  // Alamat termasking (G238) — kota + kode pos saja untuk pihak umum.
  origin: { city: string | null; postalCode: string | null };
  destination: { city: string | null; postalCode: string | null };
  lastEventAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class CourierService {
  private readonly logger = new Logger(CourierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly courierConfig: CourierConfigService,
    private readonly registry: CourierRegistry,
    private readonly storage: LocalStorageService,
    private readonly notificationQueue: NotificationQueueService,
  ) {}

  // -------------------------------------------------------------------------
  // Katalog & feature flag (G227, G249)
  // -------------------------------------------------------------------------

  async getCatalog(): Promise<unknown> {
    const [services, flags, providerConfigs] = await Promise.all([
      this.prisma.courierService.findMany({ orderBy: [{ providerCode: 'asc' }, { sortOrder: 'asc' }] }),
      this.prisma.courierRegionFlag.findMany(),
      Promise.resolve(this.courierConfig.getAllProviderConfigs()),
    ]);
    const configByCode = new Map(providerConfigs.map((c) => [c.code, c]));
    const flagByKey = new Map(flags.map((f) => [`${f.providerCode}:${f.region}`, f]));
    return services.map((s) => {
      const cfg = configByCode.get(s.providerCode);
      return {
        providerCode: s.providerCode,
        serviceCode: s.serviceCode,
        serviceName: s.serviceName,
        description: s.description,
        enabled: s.enabled,
        regions: s.regions,
        supportsPickup: s.supportsPickup,
        supportsDropoff: s.supportsDropoff,
        slaGraceDays: s.slaGraceDays,
        globalFlag: flagByKey.get(`${s.providerCode}:*`)?.enabled ?? false,
        regionFlags: flags.filter((f) => f.providerCode === s.providerCode && f.region !== '*'),
        configEnabled: cfg?.enabled ?? false,
        hasHmacSecret: !!this.courierConfig.resolveSecret(cfg?.hmacSecretRef),
      };
    });
  }

  /** Apakah provider boleh dipakai untuk kode pos tujuan (flag + katalog + config). */
  async isProviderAvailable(providerCode: string, destinationPostalCode?: string): Promise<boolean> {
    const code = providerCode.toLowerCase();
    const cfg = this.courierConfig.getProviderConfig(code);
    if (!cfg.enabled) return false;
    const serviceCount = await this.prisma.courierService.count({
      where: { providerCode: code, enabled: true },
    });
    if (serviceCount === 0) return false;
    const region = destinationPostalCode ? regionForPostalCode(destinationPostalCode) : '*';
    const specific = await this.prisma.courierRegionFlag.findUnique({
      where: { providerCode_region: { providerCode: code, region } },
    });
    if (specific) return specific.enabled;
    const global = await this.prisma.courierRegionFlag.findUnique({
      where: { providerCode_region: { providerCode: code, region: '*' } },
    });
    return global?.enabled ?? false;
  }

  // -------------------------------------------------------------------------
  // Quote / estimasi ongkir (G228, G229, G230)
  // -------------------------------------------------------------------------

  async getQuotes(dto: QuoteRequestDto): Promise<{ quotes: ShippingQuote[]; sortedBy: string }> {
    const codes = (dto.providers?.length ? dto.providers : this.registry.listCodes())
      .map((c) => c.toLowerCase())
      .filter((c) => this.registry.has(c));

    const quotes: ShippingQuote[] = [];
    for (const code of codes) {
      if (!(await this.isProviderAvailable(code, dto.destinationPostalCode))) continue;
      const p = this.registry.get(code);
      if (!p) continue;
      try {
        // Validasi format kode pos SEBELUM meminta tarif (G229).
        const validated = await p.validateAddress({
          name: 'Validasi',
          phone: '+6280000000000',
          address: 'Jl. Validasi No. 1, Kecamatan Validasi',
          city: dto.destinationCity ?? 'Kota',
          postalCode: dto.destinationPostalCode,
        });
        void validated;
        const qs = await p.getQuote({
          originPostalCode: dto.originPostalCode,
          destinationPostalCode: dto.destinationPostalCode,
          originCity: dto.originCity,
          destinationCity: dto.destinationCity,
          weightGrams: dto.weightGrams,
        });
        // Hanya layanan yang masih enabled di katalog.
        const enabledServices = await this.prisma.courierService.findMany({
          where: { providerCode: code, enabled: true },
          select: { serviceCode: true },
        });
        const enabledSet = new Set(enabledServices.map((s) => s.serviceCode));
        quotes.push(...qs.filter((q) => enabledSet.has(q.serviceCode)));
      } catch (error) {
        // Satu provider gagal → jangan gagalkan seluruh perbandingan (G240).
        this.logger.warn(`Quote gagal untuk ${code}: ${(error as Error).message}`);
      }
    }

    const sort = dto.sort ?? 'price';
    quotes.sort((a, b) =>
      sort === 'eta' ? a.etaMaxDays - b.etaMaxDays || a.cost - b.cost : a.cost - b.cost || a.etaMaxDays - b.etaMaxDays,
    );
    return { quotes, sortedBy: sort };
  }

  // -------------------------------------------------------------------------
  // Shipment: create (draft) & booking (G232, G233, G243, G244)
  // -------------------------------------------------------------------------

  private async findOrderOrThrow(orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { orderId, deletedAt: null },
      select: { id: true, orderId: true, buyerId: true, sellerId: true, orderType: true, status: true },
    });
    if (!order) {
      throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order tidak ditemukan' });
    }
    if (order.orderType !== OrderType.PHYSICAL_GOODS) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Integrasi kurir hanya untuk barang fisik' });
    }
    return order;
  }

  private toMaskedShipment(s: {
    id: string; orderId: string; providerCode: string; serviceCode: string | null;
    mode: ShipmentMode; bookingState: ShipmentBookingState; status: ShipmentStatus;
    trackingNumber: string | null; costBearer: ShippingCostBearer; estimatedCost: bigint;
    actualCost: bigint | null; currency: string; etaMinDays: number | null; etaMaxDays: number | null;
    slaDueAt: Date | null; isManual: boolean; manualCourierName: string | null;
    originCity: string | null; originPostalCode: string | null; destCity: string | null;
    destPostalCode: string | null; lastEventAt: Date | null; createdAt: Date;
  }, serviceName?: string | null): MaskedShipment {
    return {
      id: s.id,
      orderId: s.orderId,
      providerCode: s.providerCode,
      serviceCode: s.serviceCode,
      serviceName: serviceName ?? null,
      mode: s.mode,
      bookingState: s.bookingState,
      status: s.status,
      trackingNumber: s.trackingNumber,
      costBearer: s.costBearer,
      estimatedCost: s.estimatedCost.toString(),
      actualCost: s.actualCost?.toString() ?? null,
      currency: s.currency,
      etaMinDays: s.etaMinDays,
      etaMaxDays: s.etaMaxDays,
      slaDueAt: s.slaDueAt,
      slaBreached: !!s.slaDueAt && s.slaDueAt.getTime() < Date.now() && !TERMINAL_STATUSES.has(s.status),
      isManual: s.isManual,
      manualCourierName: s.manualCourierName,
      origin: { city: s.originCity, postalCode: s.originPostalCode },
      destination: { city: s.destCity, postalCode: s.destPostalCode },
      lastEventAt: s.lastEventAt,
      createdAt: s.createdAt,
    };
  }

  /** Buat draf shipment — dipanggil dari checkout setelah order dibuat (G243: bearer dipilih sebelum payment). */
  async createShipment(sellerId: string, dto: CreateShipmentDto): Promise<MaskedShipment> {
    const order = await this.findOrderOrThrow(dto.orderId);
    if (order.sellerId !== sellerId) {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_NOT_ORDER_PARTICIPANT, message: 'Hanya penjual yang dapat membuat pengiriman' });
    }
    const existing = await this.prisma.shipment.findUnique({ where: { orderId: order.id } });
    if (existing) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_ALREADY_BOOKED, message: 'Pengiriman untuk order ini sudah ada' });
    }
    const providerCode = dto.providerCode.toLowerCase();
    const provider = this.registry.get(providerCode);
    if (!provider) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_WEBHOOK_UNKNOWN_PROVIDER, message: 'Provider kurir tidak dikenal' });
    }
    if (!(await this.isProviderAvailable(providerCode, dto.destination.postalCode))) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_PROVIDER_DISABLED, message: 'Provider kurir tidak aktif untuk wilayah ini' });
    }
    const catalogEntry = dto.serviceCode
      ? await this.prisma.courierService.findUnique({
          where: { providerCode_serviceCode: { providerCode, serviceCode: dto.serviceCode } },
        })
      : null;
    if (dto.serviceCode && (!catalogEntry || !catalogEntry.enabled)) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_PROVIDER_DISABLED, message: 'Layanan kurir tidak aktif' });
    }
    const mode = dto.mode ?? ShipmentMode.PICKUP;
    if (catalogEntry) {
      if (mode === ShipmentMode.PICKUP && !catalogEntry.supportsPickup) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Layanan ini tidak mendukung pickup' });
      }
      if (mode === ShipmentMode.DROPOFF && !catalogEntry.supportsDropoff) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Layanan ini tidak mendukung drop-off' });
      }
    }

    // Validasi alamat SEBELUM membuat draf (G229).
    const [originCheck, destCheck] = await Promise.all([
      provider.validateAddress(dto.origin as CourierAddress),
      provider.validateAddress(dto.destination as CourierAddress),
    ]);
    const errors = [...originCheck.errors.map((e) => `Asal: ${e}`), ...destCheck.errors.map((e) => `Tujuan: ${e}`)];
    if (errors.length > 0) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_INVALID_ADDRESS, message: errors.join('; ') });
    }

    const created = await this.prisma.shipment.create({
      data: {
        orderId: order.id,
        sellerId: order.sellerId,
        buyerId: order.buyerId,
        providerCode,
        serviceCode: dto.serviceCode ?? catalogEntry?.serviceCode ?? null,
        mode,
        costBearer: dto.costBearer ?? ShippingCostBearer.SELLER,
        estimatedCost: BigInt(Math.round(dto.estimatedCost ?? 0)),
        weightGrams: dto.weightGrams,
        originCity: originCheck.normalized!.city,
        originPostalCode: originCheck.normalized!.postalCode,
        destCity: destCheck.normalized!.city,
        destPostalCode: destCheck.normalized!.postalCode,
        // Alamat lengkap hanya di JSON privat — tidak pernah diekspos mentah (G238).
        originDetail: originCheck.normalized as unknown as Prisma.InputJsonValue,
        destDetail: destCheck.normalized as unknown as Prisma.InputJsonValue,
      },
    });
    this.logger.log(`Shipment draft dibuat: ${created.id} order=${order.orderId} provider=${providerCode}`);
    return this.toMaskedShipment(created, catalogEntry?.serviceName ?? null);
  }

  /** Booking pickup + label dari layar order (G232). */
  async bookShipment(sellerId: string, shipmentId: string, dto: BookShipmentDto): Promise<MaskedShipment> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
    if (shipment.sellerId !== sellerId) {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_NOT_ORDER_PARTICIPANT, message: 'Hanya penjual yang dapat booking' });
    }
    if (shipment.bookingState === ShipmentBookingState.BOOKED) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_ALREADY_BOOKED, message: 'Sudah di-booking' });
    }
    if (shipment.isManual) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Pengiriman ini memakai resi manual' });
    }
    const provider = this.registry.get(shipment.providerCode);
    if (!provider) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_WEBHOOK_UNKNOWN_PROVIDER, message: 'Provider kurir tidak dikenal' });
    }

    let result;
    try {
      result = await provider.bookPickup({
        orderId: shipment.orderId,
        serviceCode: shipment.serviceCode ?? 'STD',
        mode: shipment.mode === ShipmentMode.DROPOFF ? 'DROPOFF' : 'PICKUP',
        origin: shipment.originDetail as unknown as CourierAddress,
        destination: shipment.destDetail as unknown as CourierAddress,
        weightGrams: shipment.weightGrams ?? 1000,
        note: dto.note,
      });
    } catch (error) {
      await this.prisma.shipment.update({
        where: { id: shipment.id },
        data: { bookingState: ShipmentBookingState.FAILED },
      });
      await this.recordEvent(shipment.id, shipment.providerCode, `local-book-fail-${Date.now()}`, 'BOOKING_FAILED', ShipmentStatus.UNKNOWN, undefined, `Booking gagal: ${(error as Error).message}`);
      this.logger.error(`Booking gagal shipment=${shipment.id}: ${(error as Error).message}`);
      throw new BadRequestException({ code: ErrorCodes.COURIER_BOOKING_FAILED, message: `Booking ke ${shipment.providerCode} gagal: ${(error as Error).message}` });
    }

    // Simpan label sebagai fileKey PRIVAT (G233) — bukan URL publik.
    const labelFileKey = `uploads/shipping-labels/${shipment.id}/label-${Date.now()}.pdf`;
    await this.storage.saveFile(labelFileKey, result.label);

    const catalogEntry = shipment.serviceCode
      ? await this.prisma.courierService.findUnique({
          where: { providerCode_serviceCode: { providerCode: shipment.providerCode, serviceCode: shipment.serviceCode } },
        })
      : null;
    const slaGraceDays = catalogEntry?.slaGraceDays ?? 2;
    const now = new Date();
    const slaDueAt = new Date(now.getTime() + (result.etaMaxDays + slaGraceDays) * 24 * 3600 * 1000);

    const updated = await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        bookingState: ShipmentBookingState.BOOKED,
        status: ShipmentStatus.CREATED,
        providerBookingId: result.providerBookingId,
        trackingNumber: result.trackingNumber,
        labelFileKey,
        labelMimeType: result.labelMimeType,
        actualCost: BigInt(result.actualCost),
        etaMinDays: result.etaMinDays,
        etaMaxDays: result.etaMaxDays,
        slaDueAt,
        lastEventAt: now,
        lastEventRaw: 'BOOKED',
      },
    });

    await this.recordEvent(shipment.id, shipment.providerCode, `local-booked-${result.providerBookingId}`, 'BOOKED', ShipmentStatus.CREATED, undefined, `Booking berhasil. Resi: ${result.trackingNumber}`);

    // Salin resi ke field order agar UI buyer existing (order.trackingNumber) tetap jalan.
    await this.prisma.order.update({
      where: { id: shipment.orderId },
      data: { trackingNumber: result.trackingNumber, courierName: provider.displayName },
    }).catch((e) => this.logger.warn(`Gagal mirror resi ke order: ${(e as Error).message}`));

    await this.notifyParties(updated, ShipmentStatus.CREATED, 'Label pengiriman dibuat', `Resi ${result.trackingNumber} (${provider.displayName}). Estimasi tiba ${result.etaMinDays}–${result.etaMaxDays} hari.`);

    return this.toMaskedShipment(updated, catalogEntry?.serviceName ?? null);
  }

  // -------------------------------------------------------------------------
  // Baca shipment (dengan masking G238)
  // -------------------------------------------------------------------------

  private async assertParticipant(userId: string, shipmentId: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
    if (shipment.sellerId !== userId && shipment.buyerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_NOT_ORDER_PARTICIPANT, message: 'Bukan pihak order ini' });
    }
    return shipment;
  }

  async getShipment(userId: string, shipmentId: string): Promise<MaskedShipment> {
    const shipment = await this.assertParticipant(userId, shipmentId);
    const catalogEntry = shipment.serviceCode
      ? await this.prisma.courierService.findUnique({
          where: { providerCode_serviceCode: { providerCode: shipment.providerCode, serviceCode: shipment.serviceCode } },
          select: { serviceName: true },
        })
      : null;
    return this.toMaskedShipment(shipment, catalogEntry?.serviceName ?? null);
  }

  async getShipmentByOrder(userId: string, orderId: string): Promise<MaskedShipment | null> {
    const order = await this.prisma.order.findFirst({
      where: { orderId, deletedAt: null },
      select: { id: true, buyerId: true, sellerId: true },
    });
    if (!order) throw new NotFoundException({ code: ErrorCodes.ORDER_NOT_FOUND, message: 'Order tidak ditemukan' });
    if (order.sellerId !== userId && order.buyerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_NOT_ORDER_PARTICIPANT, message: 'Bukan pihak order ini' });
    }
    const shipment = await this.prisma.shipment.findUnique({ where: { orderId: order.id } });
    if (!shipment) return null;
    return this.getShipment(userId, shipment.id);
  }

  async listEvents(userId: string, shipmentId: string): Promise<unknown[]> {
    await this.assertParticipant(userId, shipmentId);
    const events = await this.prisma.shipmentEvent.findMany({
      where: { shipmentId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, rawStatus: true, status: true, locationMasked: true, description: true, occurredAt: true, createdAt: true },
    });
    return events;
  }

  // -------------------------------------------------------------------------
  // Tracking: refresh manual (G239), timeout → UNKNOWN (G240)
  // -------------------------------------------------------------------------

  async refreshTracking(userId: string, shipmentId: string): Promise<{ status: ShipmentStatus; events: number; timeout: boolean }> {
    const shipment = await this.assertParticipant(userId, shipmentId);
    return this.refreshTrackingForShipment(shipment, 'user');
  }

  /**
   * Wave 2 integritas-139: refresh tracking oleh admin (tanpa cek partisipan;
   * guard admin ada di controller). Logika provider IDENTIK dengan jalur user.
   */
  async refreshShipmentTrackingAdmin(shipmentId: string, adminId: string): Promise<{ status: ShipmentStatus; events: number; timeout: boolean }> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) {
      throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
    }
    this.logger.log(`Refresh tracking admin=${adminId} shipment=${shipment.id}`);
    return this.refreshTrackingForShipment(shipment, 'admin');
  }

  private async refreshTrackingForShipment(
    shipment: { id: string; trackingNumber: string | null; isManual: boolean; providerCode: string; status: ShipmentStatus },
    _actor: 'user' | 'admin',
  ): Promise<{ status: ShipmentStatus; events: number; timeout: boolean }> {
    if (!shipment.trackingNumber || shipment.isManual) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_TRACKING_UNAVAILABLE, message: 'Belum ada nomor resi provider' });
    }
    const provider = this.registry.get(shipment.providerCode);
    if (!provider) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_WEBHOOK_UNKNOWN_PROVIDER, message: 'Provider kurir tidak dikenal' });
    }

    let events: ProviderTrackingEvent[];
    try {
      events = await provider.track(shipment.trackingNumber);
    } catch (error) {
      if (error instanceof CourierTimeoutError) {
        // G240: JANGAN mengarang status — tandai UNKNOWN.
        this.logger.warn(`Tracking timeout shipment=${shipment.id} provider=${shipment.providerCode}`);
        await this.prisma.shipment.update({
          where: { id: shipment.id },
          data: TERMINAL_STATUSES.has(shipment.status) ? {} : { status: ShipmentStatus.UNKNOWN },
        });
        await this.recordEvent(shipment.id, shipment.providerCode, `local-timeout-${Date.now()}`, 'PROVIDER_TIMEOUT', ShipmentStatus.UNKNOWN, undefined, 'Provider tidak merespons saat refresh manual. Status: tidak diketahui.');
        return { status: ShipmentStatus.UNKNOWN, events: 0, timeout: true };
      }
      throw new BadRequestException({ code: ErrorCodes.COURIER_TRACKING_UNAVAILABLE, message: `Gagal menarik tracking: ${(error as Error).message}` });
    }

    let applied = 0;
    for (const e of events) {
      const ok = await this.applyProviderEvent(shipment.id, shipment.providerCode, e);
      if (ok) applied++;
    }
    const fresh = await this.prisma.shipment.findUnique({ where: { id: shipment.id }, select: { status: true } });
    return { status: fresh?.status ?? shipment.status, events: applied, timeout: false };
  }

  // -------------------------------------------------------------------------
  // Webhook tracking (G235, G236, G237)
  // -------------------------------------------------------------------------

  /**
   * Verifikasi signature HMAC webhook — FAIL-CLOSED (G235).
   * Skema: header `X-Courier-Signature: sha256=<hex(hmac_sha256(rawBody, secret))>`.
   * Secret diambil dari env var yang ditunjuk `hmacSecretRef` per provider.
   */
  verifyWebhookSignature(providerCode: string, rawBody: Buffer, signatureHeader?: string): boolean {
    const cfg = this.courierConfig.getProviderConfig(providerCode.toLowerCase());
    const secret = this.courierConfig.resolveSecret(cfg.hmacSecretRef);
    if (!secret) {
      this.logger.error(`[SECURITY] Webhook ${providerCode} ditolak: HMAC secret belum dikonfigurasi (fail-closed)`);
      return false;
    }
    if (!signatureHeader) return false;
    const m = signatureHeader.match(/^sha256=([0-9a-fA-F]+)$/);
    if (!m) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(m[1], 'hex');
    } catch {
      return false;
    }
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  /**
   * Tangani webhook tracking. Idempoten via idempotency key provider + dedup
   * event (G237). Selalu mengembalikan 200-OK shape agar provider tidak retry
   * tanpa henti — kecuali signature invalid (401, fail-closed).
   */
  async handleWebhook(
    providerCode: string,
    rawBody: Buffer,
    signatureHeader: string | undefined,
    idempotencyHeader: string | undefined,
  ): Promise<{ outcome: string }> {
    const code = providerCode.toLowerCase();
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    const signatureValid = this.verifyWebhookSignature(code, rawBody, signatureHeader);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
    } catch {
      await this.logWebhook(code, null, idempotencyHeader, false, payloadHash, 'REJECTED', 'Body bukan JSON valid');
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Body webhook bukan JSON valid' });
    }

    if (!signatureValid) {
      await this.logWebhook(code, null, idempotencyHeader, false, payloadHash, 'REJECTED', 'Signature HMAC tidak valid');
      throw new ForbiddenException({ code: ErrorCodes.COURIER_WEBHOOK_SIGNATURE_INVALID, message: 'Signature webhook tidak valid' });
    }

    const idempotencyKey = idempotencyHeader ?? (typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : undefined);
    if (idempotencyKey) {
      const seen = await this.prisma.courierWebhookLog.findFirst({
        where: { providerCode: code, idempotencyKey, outcome: { in: ['PROCESSED', 'DUPLICATE'] } },
        select: { id: true },
      });
      if (seen) {
        await this.logWebhook(code, null, idempotencyKey, true, payloadHash, 'DUPLICATE', null);
        return { outcome: 'duplicate' };
      }
    } else {
      // Fallback: hash payload yang sama persis dalam 24 jam dianggap duplikat.
      const seen = await this.prisma.courierWebhookLog.findFirst({
        where: { providerCode: code, payloadHash, createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) }, outcome: { in: ['PROCESSED', 'DUPLICATE'] } },
        select: { id: true },
      });
      if (seen) {
        await this.logWebhook(code, null, idempotencyKey, true, payloadHash, 'DUPLICATE', null);
        return { outcome: 'duplicate' };
      }
    }

    const trackingNumber = String(payload.trackingNumber ?? payload.awb ?? '');
    if (!trackingNumber) {
      await this.logWebhook(code, null, idempotencyKey, true, payloadHash, 'REJECTED', 'Payload tanpa trackingNumber');
      return { outcome: 'ignored' };
    }
    const shipment = await this.prisma.shipment.findFirst({ where: { trackingNumber } });
    if (!shipment) {
      await this.logWebhook(code, null, idempotencyKey, true, payloadHash, 'REJECTED', `Resi ${trackingNumber} tidak dikenal`);
      return { outcome: 'ignored' };
    }

    const rawStatus = String(payload.status ?? payload.rawStatus ?? 'UNKNOWN');
    const event: ProviderTrackingEvent = {
      providerEventId: String(payload.eventId ?? payload.providerEventId ?? `${payloadHash.slice(0, 16)}`),
      rawStatus,
      location: typeof payload.location === 'string' ? payload.location : undefined,
      description: typeof payload.description === 'string' ? payload.description : undefined,
      occurredAt: payload.occurredAt ? new Date(String(payload.occurredAt)) : new Date(),
    };

    const applied = await this.applyProviderEvent(shipment.id, code, event);
    await this.logWebhook(code, shipment.id, idempotencyKey, true, payloadHash, 'PROCESSED', null);
    return { outcome: applied ? 'processed' : 'duplicate' };
  }

  private async logWebhook(
    providerCode: string,
    shipmentId: string | null,
    idempotencyKey: string | undefined,
    signatureValid: boolean,
    payloadHash: string,
    outcome: string,
    error: string | null,
  ): Promise<void> {
    await this.prisma.courierWebhookLog.create({
      data: { providerCode, shipmentId, idempotencyKey, signatureValid, payloadHash, outcome, error },
    }).catch((e) => this.logger.warn(`Gagal menulis webhook log: ${(e as Error).message}`));
  }

  /**
   * Terapkan satu event provider: normalisasi (G236) + dedup toleran
   * out-of-order (G237) + notifikasi (G246).
   * @returns true bila event baru diterapkan, false bila duplikat.
   */
  async applyProviderEvent(shipmentId: string, providerCode: string, event: ProviderTrackingEvent): Promise<boolean> {
    const { status, known } = normalizeRawStatus(event.rawStatus);
    if (!known) {
      this.logger.warn(`Event tak dikenal dari ${providerCode}: rawStatus="${event.rawStatus}" → UNKNOWN`);
    }
    try {
      await this.prisma.shipmentEvent.create({
        data: {
          shipmentId,
          providerEventId: event.providerEventId,
          providerCode,
          rawStatus: event.rawStatus,
          status,
          locationMasked: maskLocation(event.location),
          description: event.description,
          occurredAt: event.occurredAt ?? new Date(),
        },
      });
    } catch (error) {
      // Unique violation (shipmentId, providerEventId) → duplikat, abaikan (G237).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }

    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (shipment && !TERMINAL_STATUSES.has(shipment.status)) {
      if (STATUS_RANK[status] >= STATUS_RANK[shipment.status]) {
        await this.prisma.shipment.update({
          where: { id: shipmentId },
          data: { status, lastEventAt: new Date(), lastEventRaw: event.rawStatus },
        });
        await this.notifyParties(shipment, status, this.notificationTitleFor(status), this.notificationBodyFor(shipment, status, event));
      } else {
        await this.prisma.shipment.update({
          where: { id: shipmentId },
          data: { lastEventAt: new Date(), lastEventRaw: event.rawStatus },
        });
      }
    }
    return true;
  }

  private async recordEvent(
    shipmentId: string,
    providerCode: string,
    providerEventId: string,
    rawStatus: string,
    status: ShipmentStatus,
    location: string | undefined,
    description: string,
  ): Promise<void> {
    await this.prisma.shipmentEvent.create({
      data: { shipmentId, providerEventId, providerCode, rawStatus, status, locationMasked: location ? maskLocation(location) : undefined, description, occurredAt: new Date() },
    }).catch((e) => this.logger.warn(`Gagal mencatat event: ${(e as Error).message}`));
  }

  // -------------------------------------------------------------------------
  // Notifikasi (G246) — memakai notification service existing
  // -------------------------------------------------------------------------

  private notificationTitleFor(status: ShipmentStatus): string {
    switch (status) {
      case ShipmentStatus.PICKED_UP: return 'Paket telah dijemput kurir';
      case ShipmentStatus.IN_TRANSIT: return 'Paket dalam perjalanan';
      case ShipmentStatus.OUT_FOR_DELIVERY: return 'Paket sedang diantar kurir';
      case ShipmentStatus.DELIVERED: return 'Paket telah diterima';
      case ShipmentStatus.EXCEPTION: return 'Kendala pengiriman';
      case ShipmentStatus.RETURNED: return 'Paket dikembalikan';
      case ShipmentStatus.CREATED: return 'Label pengiriman dibuat';
      default: return 'Update pengiriman';
    }
  }

  private notificationBodyFor(
    shipment: { trackingNumber: string | null; orderId: string },
    status: ShipmentStatus,
    event: ProviderTrackingEvent,
  ): string {
    const resi = shipment.trackingNumber ?? 'resi belum tersedia';
    const extra = event.description ? ` ${event.description}` : '';
    switch (status) {
      case ShipmentStatus.PICKED_UP: return `Paket order ${shipment.orderId} dijemput kurir. Resi: ${resi}.${extra}`;
      case ShipmentStatus.IN_TRANSIT: return `Paket order ${shipment.orderId} dalam perjalanan. Resi: ${resi}.${extra}`;
      case ShipmentStatus.OUT_FOR_DELIVERY: return `Paket order ${shipment.orderId} sedang diantar ke alamatmu. Resi: ${resi}.${extra}`;
      case ShipmentStatus.DELIVERED: return `Paket order ${shipment.orderId} telah diterima. Resi: ${resi}.${extra}`;
      case ShipmentStatus.EXCEPTION: return `Ada kendala pada pengiriman order ${shipment.orderId}. Resi: ${resi}.${extra} Hubungi penjual bila perlu.`;
      case ShipmentStatus.RETURNED: return `Paket order ${shipment.orderId} dikembalikan ke penjual. Resi: ${resi}.${extra}`;
      default: return `Ada update pengiriman untuk order ${shipment.orderId}. Resi: ${resi}.${extra}`;
    }
  }

  private notificationTypeFor(status: ShipmentStatus): NotificationType {
    return status === ShipmentStatus.DELIVERED ? NotificationType.ORDER_DELIVERED : NotificationType.ORDER_SHIPPED;
  }

  private async notifyParties(
    shipment: { id: string; orderId: string; buyerId: string; sellerId: string; trackingNumber: string | null },
    status: ShipmentStatus,
    title: string,
    body: string,
  ): Promise<void> {
    const type = this.notificationTypeFor(status);
    // actionUrl memuat status agar dedup 5-menit antrean tidak menelan update
    // status BERBEDA untuk order yang sama.
    const actionUrl = `kahade://tracking/${shipment.id}?status=${status}`;
    const buyerPayload = {
      userId: shipment.buyerId,
      type,
      title,
      body,
      pushData: { orderId: shipment.orderId, shipmentId: shipment.id, courierStatus: String(status) },
      actionUrl,
      language: 'id' as const,
    };
    const enqueue = (p: typeof buyerPayload, context: string) =>
      this.notificationQueue.enqueue(p).catch((e: unknown) =>
        this.logger.warn(`${context} notification enqueue failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    void enqueue(buyerPayload, `COURIER buyer shipment=${shipment.id}`);
    // Penjual juga dikabari untuk event penting: delivered / exception / returned.
    if (status === ShipmentStatus.DELIVERED || status === ShipmentStatus.EXCEPTION || status === ShipmentStatus.RETURNED) {
      void enqueue({ ...buyerPayload, userId: shipment.sellerId }, `COURIER seller shipment=${shipment.id}`);
    }
  }

  // -------------------------------------------------------------------------
  // Label aman (G234): signed URL terautentikasi, expiry singkat
  // -------------------------------------------------------------------------

  private labelSigningSecret(): string {
    const secret = this.config.get<string>('COURIER_LABEL_SIGNING_SECRET');
    if (!secret) {
      throw new ServiceUnavailableException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Unduhan label belum dikonfigurasi server' });
    }
    return secret;
  }

  async getLabelDownloadUrl(userId: string, shipmentId: string): Promise<{ url: string; expiresAt: string }> {
    const shipment = await this.assertParticipant(userId, shipmentId);
    if (!shipment.labelFileKey || shipment.bookingState !== ShipmentBookingState.BOOKED) {
      throw new NotFoundException({ code: ErrorCodes.SHIPMENT_LABEL_NOT_AVAILABLE, message: 'Label belum tersedia' });
    }
    const exp = Math.floor(Date.now() / 1000) + LABEL_URL_TTL_SECONDS;
    const sig = createHmac('sha256', this.labelSigningSecret()).update(`${shipment.id}:${exp}`).digest('hex');
    return {
      url: `/v1/courier/shipments/${shipment.id}/label/file?exp=${exp}&sig=${sig}`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  /** Verifikasi signature URL label (fail-closed) + kembalikan fileKey. */
  async resolveLabelFile(shipmentId: string, exp: string, sig: string): Promise<{ fileKey: string; mimeType: string }> {
    const expNum = Number.parseInt(exp, 10);
    if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_LABEL_URL_EXPIRED, message: 'Tautan label kedaluwarsa' });
    }
    const expected = createHmac('sha256', this.labelSigningSecret()).update(`${shipmentId}:${expNum}`).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, 'hex');
    } catch {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_LABEL_URL_EXPIRED, message: 'Tautan label tidak valid' });
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_LABEL_URL_EXPIRED, message: 'Tautan label tidak valid' });
    }
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment?.labelFileKey) {
      throw new NotFoundException({ code: ErrorCodes.SHIPMENT_LABEL_NOT_AVAILABLE, message: 'Label belum tersedia' });
    }
    return { fileKey: shipment.labelFileKey, mimeType: shipment.labelMimeType ?? 'application/pdf' };
  }

  // -------------------------------------------------------------------------
  // Void label (G242) + fallback resi manual (G241)
  // -------------------------------------------------------------------------

  async voidShipment(sellerId: string, shipmentId: string, dto: VoidShipmentDto): Promise<MaskedShipment> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
    if (shipment.sellerId !== sellerId) {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_NOT_ORDER_PARTICIPANT, message: 'Hanya penjual yang dapat membatalkan' });
    }
    if (shipment.bookingState !== ShipmentBookingState.BOOKED) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Hanya booking aktif yang dapat dibatalkan' });
    }
    const provider = this.registry.get(shipment.providerCode);
    if (provider && shipment.providerBookingId) {
      try {
        await provider.voidBooking(shipment.providerBookingId, dto.reason);
      } catch (error) {
        this.logger.error(`Void provider gagal shipment=${shipment.id}: ${(error as Error).message}`);
        throw new BadRequestException({ code: ErrorCodes.COURIER_VOID_FAILED, message: `Gagal membatalkan di provider: ${(error as Error).message}` });
      }
    }
    const updated = await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: { bookingState: ShipmentBookingState.VOIDED, voidedAt: new Date(), voidReason: dto.reason },
    });
    // Riwayat: catat sebagai event di timeline pengiriman order ini.
    await this.recordEvent(shipment.id, shipment.providerCode, `local-void-${Date.now()}`, 'VOIDED_BY_SELLER', ShipmentStatus.UNKNOWN, undefined, `Label dibatalkan penjual. Alasan: ${dto.reason}`);
    await this.notifyParties(updated, ShipmentStatus.UNKNOWN, 'Label pengiriman dibatalkan', `Label untuk order ${updated.orderId} dibatalkan penjual.`);
    return this.toMaskedShipment(updated);
  }

  /** Fallback resi manual bila provider nonaktif/tidak tersedia (G241). */
  async setManualResi(sellerId: string, shipmentId: string, dto: ManualResiDto): Promise<MaskedShipment> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
    if (shipment.sellerId !== sellerId) {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_NOT_ORDER_PARTICIPANT, message: 'Hanya penjual yang dapat mengisi resi' });
    }
    if (shipment.bookingState === ShipmentBookingState.BOOKED) {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Booking provider aktif — batalkan dulu sebelum pakai resi manual' });
    }
    const updated = await this.prisma.shipment.update({
      where: { id: shipment.id },
      data: {
        isManual: true,
        manualTrackingNumber: dto.trackingNumber,
        manualCourierName: dto.courierName,
        trackingNumber: dto.trackingNumber,
        status: ShipmentStatus.PICKED_UP,
        lastEventAt: new Date(),
        lastEventRaw: 'MANUAL_RESI',
      },
    });
    await this.recordEvent(shipment.id, 'manual', `manual-${Date.now()}`, 'MANUAL_RESI', ShipmentStatus.PICKED_UP, undefined, `Resi manual oleh penjual: ${dto.courierName} ${dto.trackingNumber}${dto.note ? ` — ${dto.note}` : ''}`);
    // Mirror ke field order agar alur buyer existing tetap membaca resi.
    await this.prisma.order.update({
      where: { id: shipment.orderId },
      data: { trackingNumber: dto.trackingNumber, courierName: dto.courierName },
    }).catch((e) => this.logger.warn(`Gagal mirror resi manual ke order: ${(e as Error).message}`));
    await this.notifyParties(updated, ShipmentStatus.PICKED_UP, 'Penjual mengisi resi pengiriman', `Resi ${dto.courierName} ${dto.trackingNumber} untuk order ${updated.orderId}.`);
    return this.toMaskedShipment(updated);
  }

  // -------------------------------------------------------------------------
  // State machine refund ongkir: REQUESTED → APPROVED → PAID (tidak pernah
  // menyentuh wallet langsung; payout mengikuti alur markRefundPaid).
  // SYS-B-501: SEMUA pintu nominal (request, decide-APPROVED, mark-paid,
  // admin approve) wajib lewat validateShippingRefundAmount — cap =
  // costBase − refundedAmount.
  // -------------------------------------------------------------------------

  /** Putuskan refund (REQUESTED → APPROVED/REJECTED) — admin. */
  async decideRefund(refundId: string, dto: DecideRefundDto, adminId: string) {
    const refund = await this.prisma.shippingCostRefund.findUnique({ where: { id: refundId } });
    if (!refund) throw new NotFoundException({ code: ErrorCodes.SHIPPING_REFUND_NOT_FOUND, message: 'Refund tidak ditemukan' });
    if (refund.status !== 'REQUESTED') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Refund sudah diputus' });
    }
    // SYS-B-501: keputusan APPROVED memvalidasi ulang nominal terhadap sisa.
    if (dto.decision === 'APPROVED') {
      const shipment = await this.prisma.shipment.findUnique({ where: { id: refund.shipmentId } });
      if (!shipment) throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
      validateShippingRefundAmount(
        { costBase: shipment.actualCost ?? shipment.estimatedCost, refundedAmount: shipment.refundedAmount },
        refund.amount,
      );
    }
    const updated = await this.prisma.shippingCostRefund.update({
      where: { id: refundId },
      data: {
        status: dto.decision as ShippingRefundStatus,
        decidedBy: adminId,
        decidedAt: new Date(),
        reason: dto.note ? `${refund.reason}\n[Admin] ${dto.note}` : refund.reason,
      },
    });
    this.logger.log(`Refund ongkir ${refundId} diputus ${dto.decision} oleh admin=${adminId}`);
    return { ...updated, amount: updated.amount.toString() };
  }

  /** Tandai refund sudah dibayar — menambah refundedAmount di shipment (audit). */
  async markRefundPaid(refundId: string, adminId: string) {
    const refund = await this.prisma.shippingCostRefund.findUnique({ where: { id: refundId } });
    if (!refund) throw new NotFoundException({ code: ErrorCodes.SHIPPING_REFUND_NOT_FOUND, message: 'Refund tidak ditemukan' });
    if (refund.status !== 'APPROVED') {
      throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'Hanya refund APPROVED yang bisa ditandai dibayar' });
    }
    const shipment = await this.prisma.shipment.findUnique({ where: { id: refund.shipmentId } });
    if (!shipment) throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
    // SYS-B-501: pemeriksaan cap terakhir sebelum refundedAmount bertambah.
    validateShippingRefundAmount(
      { costBase: shipment.actualCost ?? shipment.estimatedCost, refundedAmount: shipment.refundedAmount },
      refund.amount,
    );
    const [updated] = await this.prisma.$transaction([
      this.prisma.shippingCostRefund.update({ where: { id: refundId }, data: { status: 'PAID' } }),
      this.prisma.shipment.update({
        where: { id: refund.shipmentId },
        data: { refundedAmount: { increment: refund.amount } },
      }),
    ]);
    this.logger.log(`Refund ongkir ${refundId} ditandai PAID oleh admin=${adminId}`);
    return { ...updated, amount: updated.amount.toString() };
  }

  // -------------------------------------------------------------------------
  // Wave 2 integritas-139: endpoint yang dipanggil halaman admin kurir aktif.
  // Guard role di controller; semua mutasi finansial memakai state machine
  // refund yang sudah ada (REQUESTED → APPROVED → PAID) dan TIDAK menyentuh
  // wallet langsung.
  // -------------------------------------------------------------------------

  /**
   * Pengajuan refund ongkir oleh user (POST /v1/courier/shipments/:id/refunds).
   * Dipertahankan SYS-D-002: dipakai CourierController user-facing (bukan
   * bagian klaster admin mati yang dihapus).
   */
  async requestRefund(userId: string, shipmentId: string, dto: RequestRefundDto) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
    if (shipment.sellerId !== userId && shipment.buyerId !== userId) {
      throw new ForbiddenException({ code: ErrorCodes.SHIPMENT_NOT_ORDER_PARTICIPANT, message: 'Bukan pihak order ini' });
    }
    // SYS-B-501: tolak nominal > sisa sejak awal — bukan saat approve saja.
    const amount = BigInt(Math.round(dto.amount));
    validateShippingRefundAmount(
      { costBase: shipment.actualCost ?? shipment.estimatedCost, refundedAmount: shipment.refundedAmount },
      amount,
    );
    const refund = await this.prisma.shippingCostRefund.create({
      data: {
        id: randomUUID(),
        shipmentId,
        orderId: shipment.orderId,
        amount,
        reason: dto.reason,
        requestedBy: userId,
      },
    });
    return { ...refund, amount: refund.amount.toString() };
  }

  /** Daftar shipment untuk halaman admin (filter bookingState/status/provider/stale/search). */
  async listAdminShipments(query: {
    page?: number; limit?: number; bookingState?: string; status?: string;
    providerCode?: string; staleHours?: number; search?: string;
  }): Promise<{ data: MaskedShipment[]; total: number; page: number; limit: number; totalPages: number; hasNext: boolean; hasPrev: boolean }> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 20)));
    const where: Prisma.ShipmentWhereInput = {};
    if (query.bookingState) {
      if (!(query.bookingState in ShipmentBookingState)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'bookingState tidak dikenal' });
      }
      where.bookingState = query.bookingState as ShipmentBookingState;
    }
    if (query.status) {
      if (!(query.status in ShipmentStatus)) {
        throw new BadRequestException({ code: ErrorCodes.VALIDATION_ERROR, message: 'status tidak dikenal' });
      }
      where.status = query.status as ShipmentStatus;
    }
    if (query.providerCode) where.providerCode = query.providerCode.toLowerCase();
    const andClauses: Prisma.ShipmentWhereInput[] = [];
    if (query.staleHours !== undefined && query.staleHours > 0) {
      const cutoff = new Date(Date.now() - Math.min(query.staleHours, 24 * 90) * 3600 * 1000);
      andClauses.push({ OR: [{ lastEventAt: { lt: cutoff } }, { lastEventAt: null, createdAt: { lt: cutoff } }] });
    }
    const search = query.search?.trim();
    if (search) {
      andClauses.push({
        OR: [
          { trackingNumber: { contains: search, mode: 'insensitive' } },
          { orderId: { contains: search, mode: 'insensitive' } },
        ],
      });
    }
    if (andClauses.length > 0) where.AND = andClauses;
    const [total, rows] = await Promise.all([
      this.prisma.shipment.count({ where }),
      this.prisma.shipment.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return {
      data: rows.map((r) => this.toMaskedShipment(r)),
      total, page, limit, totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };
  }

  /** Daftar provider untuk halaman admin: on/off, whitelist/blacklist wilayah, prioritas. */
  async listAdminProviders(): Promise<Array<{
    providerCode: string; name: string; enabled: boolean;
    regionWhitelist: string[]; regionBlacklist: string[]; priority: number;
  }>> {
    const configs = this.courierConfig.getAllProviderConfigs();
    const [flags, sortOrders] = await Promise.all([
      this.prisma.courierRegionFlag.findMany(),
      this.prisma.courierService.groupBy({ by: ['providerCode'], _min: { sortOrder: true } }),
    ]);
    const minSortByCode = new Map(sortOrders.map((s) => [s.providerCode, s._min.sortOrder ?? 0]));
    const flagByKey = new Map(flags.map((f) => [`${f.providerCode}:${f.region}`, f]));
    return configs.map((cfg) => {
      const registryProvider = this.registry.get(cfg.code);
      const regionFlags = flags.filter((f) => f.providerCode === cfg.code && f.region !== '*');
      return {
        providerCode: cfg.code,
        name: registryProvider?.displayName ?? cfg.code.toUpperCase(),
        enabled: flagByKey.get(`${cfg.code}:*`)?.enabled ?? cfg.enabled,
        regionWhitelist: regionFlags.filter((f) => f.enabled).map((f) => f.region),
        regionBlacklist: regionFlags.filter((f) => !f.enabled).map((f) => f.region),
        priority: minSortByCode.get(cfg.code) ?? 0,
      };
    });
  }

  /** Ubah flag operasional provider (SUPER_ADMIN). Fail-closed: provider tidak dikenal → 400. */
  async updateAdminProviderFlag(providerCode: string, dto: UpdateAdminProviderFlagDto, adminId: string) {
    const code = providerCode.toLowerCase();
    if (!(KNOWN_COURIER_CODES as readonly string[]).includes(code)) {
      throw new BadRequestException({ code: ErrorCodes.COURIER_WEBHOOK_UNKNOWN_PROVIDER, message: 'Provider kurir tidak dikenal' });
    }
    if (dto.enabled !== undefined) {
      await this.prisma.courierRegionFlag.upsert({
        where: { providerCode_region: { providerCode: code, region: '*' } },
        update: { enabled: dto.enabled },
        create: { id: randomUUID(), providerCode: code, region: '*', enabled: dto.enabled },
      });
    }
    if (dto.regionWhitelist !== undefined) {
      // Whitelist = daftar definitif: hapus flag wilayah lama, tulis ulang yang diizinkan.
      await this.prisma.courierRegionFlag.deleteMany({ where: { providerCode: code, NOT: { region: '*' } } });
      if (dto.regionWhitelist.length > 0) {
        await this.prisma.courierRegionFlag.createMany({
          data: dto.regionWhitelist.map((region) => ({
            id: randomUUID(), providerCode: code, region, enabled: true,
          })),
          skipDuplicates: true,
        });
      }
    }
    if (dto.regionBlacklist !== undefined) {
      // SYS-D-003: pola batch — 1 updateMany + 1 createMany(skipDuplicates)
      // menggantikan N upsert per region. Hasil akhir identik dengan upsert
      // per region: yang sudah ada → enabled=false, yang belum ada → dibuat
      // dengan enabled=false (skipDuplicates menahan race insert ganda).
      const regions = [...new Set(dto.regionBlacklist)];
      if (regions.length > 0) {
        await this.prisma.courierRegionFlag.updateMany({
          where: { providerCode: code, region: { in: regions } },
          data: { enabled: false },
        });
        await this.prisma.courierRegionFlag.createMany({
          data: regions.map((region) => ({
            id: randomUUID(), providerCode: code, region, enabled: false,
          })),
          skipDuplicates: true,
        });
      }
    }
    if (dto.priority !== undefined) {
      await this.prisma.courierService.updateMany({
        where: { providerCode: code },
        data: { sortOrder: dto.priority },
      });
    }
    this.logger.log(`Flag provider kurir diubah admin=${adminId}: ${code}`);
    const updated = await this.listAdminProviders();
    return updated.find((p) => p.providerCode === code);
  }

  /**
   * Coba ulang booking yang GAGAL (fail-closed: hanya bookingState FAILED).
   * Reuse penuh logika bookShipment — tidak ada jalur booking paralel.
   */
  async retryShipmentBookingAdmin(shipmentId: string, adminId: string): Promise<MaskedShipment> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) {
      throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
    }
    if (shipment.bookingState !== ShipmentBookingState.FAILED) {
      throw new BadRequestException({
        code: ErrorCodes.VALIDATION_ERROR,
        message: `Hanya booking yang GAGAL yang bisa dicoba ulang (saat ini: ${shipment.bookingState})`,
      });
    }
    this.logger.log(`Retry booking shipment=${shipment.id} oleh admin=${adminId}`);
    return this.bookShipment(shipment.sellerId, shipmentId, {});
  }

  /**
   * Rekonsiliasi estimasi vs aktual per shipment (halaman admin).
   * diffSen = actualCost − estimatedCost, dihitung di SQL agar bisa difilter
   * (onlyMismatch) dan dipaginasi di DB tanpa full-scan ke aplikasi.
   */
  async getShippingReconciliation(query: { page?: number; limit?: number; onlyMismatch?: boolean }): Promise<{
    data: Array<{ shipmentId: string; orderId: string; providerCode: string; estimatedCostSen: string; actualCostSen: string; diffSen: string }>;
    total: number; page: number; limit: number; totalPages: number; hasNext: boolean; hasPrev: boolean;
  }> {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Math.floor(query.limit ?? 20)));
    const mismatchOnly = query.onlyMismatch === true;
    // Kolom DB mengikuti nama field Prisma (tanpa @map): "orderId",
    // "providerCode", "estimatedCost", "actualCost", "updatedAt".
    const baseWhere = Prisma.sql`FROM "shipments" WHERE "actualCost" IS NOT NULL`;
    const mismatchWhere = mismatchOnly ? Prisma.sql` AND ("actualCost" - "estimatedCost") <> 0` : Prisma.sql``;
    const [countRows, rows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`SELECT COUNT(*)::bigint AS count ${baseWhere} ${mismatchWhere}`,
      ),
      this.prisma.$queryRaw<Array<{
        shipmentId: string; orderId: string; providerCode: string;
        estimatedCostSen: string; actualCostSen: string; diffSen: string;
      }>>(
        Prisma.sql`SELECT "id" AS "shipmentId", "orderId", "providerCode",
          "estimatedCost"::text AS "estimatedCostSen",
          "actualCost"::text AS "actualCostSen",
          ("actualCost" - "estimatedCost")::text AS "diffSen"
          ${baseWhere} ${mismatchWhere}
          ORDER BY "updatedAt" DESC
          LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      ),
    ]);
    const total = Number(countRows[0]?.count ?? 0n);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    return { data: rows, total, page, limit, totalPages, hasNext: page < totalPages, hasPrev: page > 1 };
  }

  /**
   * Setujui refund ongkir dari halaman admin (SUPER_ADMIN/FINANCE_ADMIN).
   * Reuse state machine refund: REQUESTED → APPROVED dalam satu transaksi.
   * Fail-closed: nominal tidak boleh melebihi sisa biaya aktual yang belum
   * di-refund. TIDAK menyentuh wallet (payout mengikuti alur markRefundPaid).
   */
  async approveShippingRefund(shipmentId: string, dto: ApproveShippingRefundDto, adminId: string) {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) {
      throw new NotFoundException({ code: ErrorCodes.SHIPMENT_NOT_FOUND, message: 'Pengiriman tidak ditemukan' });
    }
    const amount = BigInt(dto.amountSen);
    // SYS-B-501: validasi terpusat — cap = costBase − refundedAmount.
    validateShippingRefundAmount(
      { costBase: shipment.actualCost ?? shipment.estimatedCost, refundedAmount: shipment.refundedAmount },
      amount,
    );
    const now = new Date();
    const refund = await this.prisma.$transaction(async (tx) => {
      const created = await tx.shippingCostRefund.create({
        data: {
          id: randomUUID(),
          shipmentId,
          orderId: shipment.orderId,
          amount,
          reason: dto.reason,
          requestedBy: adminId,
          status: ShippingRefundStatus.REQUESTED,
        },
      });
      return tx.shippingCostRefund.update({
        where: { id: created.id },
        data: { status: ShippingRefundStatus.APPROVED, decidedBy: adminId, decidedAt: now },
      });
    });
    this.logger.log(`Refund ongkir disetujui admin=${adminId}: shipment=${shipmentId} amount=${amount}`);
    return { ...refund, amount: refund.amount.toString() };
  }
}

// Re-export tipe untuk controller.
export type { ShippingQuote };
