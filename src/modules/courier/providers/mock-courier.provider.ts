/**
 * mock-courier.provider.ts — MockCourierProvider (G226, G250).
 *
 * Implementasi CourierProvider DETERMINISTIK untuk sandbox/test. Dipakai
 * untuk SEMUA kode provider katalog (jne, jnt, sicepat, gosend, anteraja,
 * paxel) selama belum ada integrasi API nyata — perilaku dibedakan per
 * providerCode via tarif/ETA yang di-seed per kode.
 *
 * Deterministik: quote & booking dihitung dari hash input, sehingga test
 * stabil tanpa jaringan. TIDAK ADA kredensial nyata.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  AddressValidationResult,
  BookingRequest,
  BookingResult,
  CourierAddress,
  CourierProvider,
  CourierProviderError,
  CourierTimeoutError,
  ProviderTrackingEvent,
  QuoteRequest,
  ShippingQuote,
} from './courier-provider.interface';

/** Tarif dasar per provider (Rp) + ETA hari — angka mock, BUKAN tarif nyata. */
const MOCK_TARIFF: Record<string, { base: number; perKg: number; etaMin: number; etaMax: number; pickup: boolean; dropoff: boolean; displayName: string }> = {
  jne:      { base: 11000, perKg: 8000,  etaMin: 2, etaMax: 4, pickup: true,  dropoff: true,  displayName: 'JNE (Mock)' },
  jnt:      { base: 10000, perKg: 7500,  etaMin: 2, etaMax: 3, pickup: true,  dropoff: true,  displayName: 'J&T Express (Mock)' },
  sicepat:  { base: 10500, perKg: 7800,  etaMin: 1, etaMax: 3, pickup: true,  dropoff: true,  displayName: 'SiCepat (Mock)' },
  gosend:   { base: 15000, perKg: 0,     etaMin: 0, etaMax: 1, pickup: true,  dropoff: false, displayName: 'GoSend (Mock)' },
  anteraja: { base: 9500,  perKg: 7000,  etaMin: 2, etaMax: 4, pickup: true,  dropoff: true,  displayName: 'AnterAja (Mock)' },
  paxel:    { base: 20000, perKg: 12000, etaMin: 1, etaMax: 2, pickup: true,  dropoff: true,  displayName: 'Paxel (Mock)' },
  mock:     { base: 9000,  perKg: 6000,  etaMin: 1, etaMax: 3, pickup: true,  dropoff: true,  displayName: 'Mock Courier' },
};

/** Kode pos Indonesia: tepat 5 digit (G229). */
export const ID_POSTAL_CODE_RE = /^\d{5}$/;

/** Hash FNV-1a 32-bit → deterministik. */
export function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Masking lokasi untuk event tracking (G238): "Jakarta Selatan" → "Jakarta S***". */
export function maskLocation(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const parts = location.trim().split(/\s+/);
  if (parts.length === 0) return undefined;
  const first = parts[0];
  const rest = parts.slice(1).map((p) => (p.length > 1 ? `${p[0]}***` : '***'));
  return [first, ...rest].join(' ');
}

@Injectable()
export class MockCourierProvider implements CourierProvider {
  private readonly logger = new Logger(MockCourierProvider.name);
  readonly code: string;
  readonly displayName: string;
  /** Bila true, track() melempar CourierTimeoutError (untuk test G240). */
  simulateTimeout = false;
  /** Latensi buatan (ms) — 0 di test agar cepat. */
  artificialLatencyMs = 0;

  constructor(code = 'mock') {
    this.code = code;
    this.displayName = MOCK_TARIFF[code]?.displayName ?? `Mock (${code})`;
  }

  private tariff() {
    return MOCK_TARIFF[this.code] ?? MOCK_TARIFF.mock;
  }

  private async maybeDelay(): Promise<void> {
    if (this.artificialLatencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.artificialLatencyMs));
    }
  }

  async validateAddress(address: CourierAddress): Promise<AddressValidationResult> {
    const errors: string[] = [];
    if (!address.name?.trim()) errors.push('Nama penerima wajib diisi');
    if (!address.phone?.trim()) errors.push('Nomor telepon wajib diisi');
    else if (!/^\+?[0-9]{9,15}$/.test(address.phone.replace(/[\s-]/g, ''))) {
      errors.push('Format nomor telepon tidak valid');
    }
    if (!address.address?.trim() || address.address.trim().length < 10) {
      errors.push('Alamat jalan minimal 10 karakter');
    }
    if (!address.city?.trim()) errors.push('Kota wajib diisi');
    if (!ID_POSTAL_CODE_RE.test(address.postalCode ?? '')) {
      errors.push('Kode pos harus 5 digit angka');
    }
    if (errors.length > 0) return { valid: false, errors };
    return {
      valid: true,
      errors: [],
      normalized: {
        name: address.name.trim(),
        phone: address.phone.replace(/[\s-]/g, ''),
        address: address.address.trim(),
        city: address.city.trim(),
        postalCode: address.postalCode,
        province: address.province?.trim() || undefined,
      },
    };
  }

  async getQuote(req: QuoteRequest): Promise<ShippingQuote[]> {
    await this.maybeDelay();
    if (!ID_POSTAL_CODE_RE.test(req.originPostalCode) || !ID_POSTAL_CODE_RE.test(req.destinationPostalCode)) {
      throw new CourierProviderError(this.code, 'getQuote', 'Kode pos harus 5 digit angka');
    }
    const t = this.tariff();
    const kg = Math.max(1, Math.ceil(req.weightGrams / 1000));
    // Variasi deterministik ±10% dari hash kode pos — simulasi zona tarif.
    const zone = fnv1a(`${req.originPostalCode}-${req.destinationPostalCode}`) % 21; // 0..20
    const zoneFactor = 1 + (zone - 10) / 100;
    const cost = Math.round((t.base + t.perKg * (kg - 1)) * zoneFactor / 500) * 500;
    const etaJitter = fnv1a(`eta-${req.originPostalCode}-${req.destinationPostalCode}`) % 2;
    return [
      {
        providerCode: this.code,
        serviceCode: 'STD',
        serviceName: `${this.displayName} Reguler`,
        cost,
        currency: 'IDR',
        etaMinDays: t.etaMin,
        etaMaxDays: t.etaMax + etaJitter,
        supportsPickup: t.pickup,
        supportsDropoff: t.dropoff,
      },
      {
        providerCode: this.code,
        serviceCode: 'EXP',
        serviceName: `${this.displayName} Express`,
        cost: Math.round(cost * 1.6 / 500) * 500,
        currency: 'IDR',
        etaMinDays: Math.max(0, t.etaMin - 1),
        etaMaxDays: t.etaMin + etaJitter,
        supportsPickup: t.pickup,
        supportsDropoff: t.dropoff,
      },
    ];
  }

  async bookPickup(req: BookingRequest): Promise<BookingResult> {
    await this.maybeDelay();
    const originCheck = await this.validateAddress(req.origin);
    const destCheck = await this.validateAddress(req.destination);
    if (!originCheck.valid || !destCheck.valid) {
      throw new CourierProviderError(this.code, 'bookPickup', `Alamat tidak valid: ${[...originCheck.errors, ...destCheck.errors].join('; ')}`);
    }
    const quotes = await this.getQuote({
      originPostalCode: req.origin.postalCode,
      destinationPostalCode: req.destination.postalCode,
      weightGrams: req.weightGrams,
    });
    const quote = quotes.find((q) => q.serviceCode === req.serviceCode) ?? quotes[0];
    const seed = fnv1a(`${req.orderId}-${this.code}-${Date.now()}`);
    const bookingId = `MOCK-${this.code.toUpperCase()}-${seed.toString(36).toUpperCase()}`;
    const trackingNumber = `${this.code.toUpperCase()}${String(seed).padStart(10, '0')}`;
    const label = this.renderLabel(bookingId, trackingNumber, req);
    return {
      providerBookingId: bookingId,
      trackingNumber,
      label,
      labelMimeType: 'application/pdf',
      // Simulasi "aktual bisa beda dari estimasi": +0..4% deterministik.
      actualCost: Math.round(quote.cost * (1 + (seed % 5) / 100)),
      currency: 'IDR',
      etaMinDays: quote.etaMinDays,
      etaMaxDays: quote.etaMaxDays,
    };
  }

  /** Label mock: PDF minimal yang valid (bukan URL publik). */
  private renderLabel(bookingId: string, trackingNumber: string, req: BookingRequest): Buffer {
    const lines = [
      `Kahade Shipping Label (MOCK)`,
      `Provider: ${this.displayName}`,
      `Booking: ${bookingId}`,
      `Resi: ${trackingNumber}`,
      `Order: ${req.orderId}`,
      `Mode: ${req.mode}`,
      `Dari: ${req.origin.name} - ${req.origin.city} ${req.origin.postalCode}`,
      `Ke: ${req.destination.name} - ${req.destination.city} ${req.destination.postalCode}`,
      `Berat: ${req.weightGrams}g`,
    ];
    const text = lines.join('\\n');
    // PDF 1.4 minimal — cukup untuk diunduh/dicetak sebagai label mock.
    const content = `BT /F1 12 Tf 50 750 Td 14 TL (${text.replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\\n/g, ') Tj T* (')}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((obj, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    });
    const xrefPos = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    offsets.forEach((o) => { pdf += `${String(o).padStart(10, '0')} 00000 n \n`; });
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    return Buffer.from(pdf, 'utf-8');
  }

  async getLabel(providerBookingId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    await this.maybeDelay();
    if (!providerBookingId.startsWith('MOCK-')) {
      throw new CourierProviderError(this.code, 'getLabel', 'Booking ID tidak dikenal');
    }
    // Label deterministik dari booking ID — cukup untuk mock.
    const seed = fnv1a(providerBookingId);
    const trackingNumber = `${this.code.toUpperCase()}${String(seed).padStart(10, '0')}`;
    const label = this.renderLabel(providerBookingId, trackingNumber, {
      orderId: 'unknown',
      serviceCode: 'STD',
      mode: 'PICKUP',
      origin: { name: '-', phone: '-', address: '-', city: '-', postalCode: '00000' },
      destination: { name: '-', phone: '-', address: '-', city: '-', postalCode: '00000' },
      weightGrams: 1000,
    });
    return { buffer: label, mimeType: 'application/pdf' };
  }

  async track(trackingNumber: string): Promise<ProviderTrackingEvent[]> {
    await this.maybeDelay();
    if (this.simulateTimeout) {
      throw new CourierTimeoutError(this.code, 'track');
    }
    if (!trackingNumber) {
      throw new CourierProviderError(this.code, 'track', 'Nomor resi wajib diisi');
    }
    // Timeline canned deterministik dari hash resi: progres = hash % 6 tahap.
    const seed = fnv1a(trackingNumber);
    const stage = seed % 6;
    const base = Date.now() - stage * 20 * 3600 * 1000;
    const stages: Array<Omit<ProviderTrackingEvent, 'providerEventId'>> = [
      { rawStatus: 'CREATED', location: 'Jakarta Selatan Hub', description: 'Label dibuat, menunggu pickup', occurredAt: new Date(base) },
      { rawStatus: 'PICKED_UP', location: 'Jakarta Selatan Hub', description: 'Paket dijemput kurir', occurredAt: new Date(base + 2 * 3600 * 1000) },
      { rawStatus: 'IN_TRANSIT', location: 'Bandung Transit Center', description: 'Paket dalam perjalanan', occurredAt: new Date(base + 8 * 3600 * 1000) },
      { rawStatus: 'OUT_FOR_DELIVERY', location: 'Surabaya Timur', description: 'Paket sedang diantar kurir', occurredAt: new Date(base + 14 * 3600 * 1000) },
      { rawStatus: 'DELIVERED', location: 'Surabaya Timur', description: 'Paket diterima', occurredAt: new Date(base + 18 * 3600 * 1000) },
    ];
    return stages.slice(0, stage + 1).map((s, i) => ({
      ...s,
      providerEventId: `mock-evt-${fnv1a(`${trackingNumber}-${i}`).toString(36)}`,
    }));
  }

  async voidBooking(providerBookingId: string, _reason?: string): Promise<void> {
    await this.maybeDelay();
    if (!providerBookingId.startsWith('MOCK-')) {
      throw new CourierProviderError(this.code, 'voidBooking', 'Booking ID tidak dikenal');
    }
    this.logger.log(`Mock void booking ${providerBookingId}`);
  }
}
