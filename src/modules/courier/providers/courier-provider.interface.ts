/**
 * courier-provider.interface.ts — abstraction layer provider kurir (G226).
 *
 * Semua integrasi kurir (JNE, J&T, SiCepat, GoSend, AnterAja, Paxel, mock)
 * WAJIB mengimplementasikan interface ini dan didaftarkan di CourierRegistry.
 * TIDAK ADA kredensial nyata di implementasi — secret hanya via env/config
 * (lihat ../courier.config.ts).
 */

export interface CourierAddress {
  name: string;
  phone: string;
  address: string;
  city: string;
  postalCode: string;
  province?: string;
}

export interface QuoteRequest {
  originPostalCode: string;
  destinationPostalCode: string;
  originCity?: string;
  destinationCity?: string;
  /** Berat dalam gram. */
  weightGrams: number;
}

export interface ShippingQuote {
  providerCode: string;
  serviceCode: string;
  serviceName: string;
  /** Ongkir dalam rupiah. */
  cost: number;
  currency: string;
  etaMinDays: number;
  etaMaxDays: number;
  supportsPickup: boolean;
  supportsDropoff: boolean;
}

export interface AddressValidationResult {
  valid: boolean;
  normalized?: CourierAddress;
  errors: string[];
}

export interface BookingRequest {
  orderId: string;
  serviceCode: string;
  mode: 'PICKUP' | 'DROPOFF';
  origin: CourierAddress;
  destination: CourierAddress;
  weightGrams: number;
  /** Catatan untuk kurir (opsional). */
  note?: string;
}

export interface BookingResult {
  providerBookingId: string;
  trackingNumber: string;
  label: Buffer;
  labelMimeType: string;
  /** Ongkir AKTUAL dari provider (bisa beda dari estimasi). */
  actualCost: number;
  currency: string;
  etaMinDays: number;
  etaMaxDays: number;
}

export interface ProviderTrackingEvent {
  /** ID event unik dari provider — dipakai sebagai kunci dedup. */
  providerEventId: string;
  /** Status mentah provider, mis. "PICKUP", "ON_PROCESS", "DELIVERED". */
  rawStatus: string;
  /** Lokasi — akan dimasking sebelum disimpan/ditampilkan. */
  location?: string;
  description?: string;
  occurredAt?: Date;
}

/** Error khusus timeout provider — service memetakannya ke UNKNOWN (G240). */
export class CourierTimeoutError extends Error {
  constructor(providerCode: string, operation: string) {
    super(`Provider ${providerCode} timeout saat ${operation}`);
    this.name = 'CourierTimeoutError';
  }
}

export class CourierProviderError extends Error {
  constructor(
    providerCode: string,
    public readonly operation: string,
    message: string,
  ) {
    super(`[${providerCode}/${operation}] ${message}`);
    this.name = 'CourierProviderError';
  }
}

export interface CourierProvider {
  /** Kode unik provider, mis. "jne", "mock". */
  readonly code: string;
  /** Nama tampil provider. */
  readonly displayName: string;

  /** Estimasi ongkir & ETA (G228). */
  getQuote(req: QuoteRequest): Promise<ShippingQuote[]>;
  /** Booking pickup + label (G232). */
  bookPickup(req: BookingRequest): Promise<BookingResult>;
  /** Ambil ulang label untuk booking yang sudah ada. */
  getLabel(providerBookingId: string): Promise<{ buffer: Buffer; mimeType: string }>;
  /** Tarik status tracking (G239). Timeout → CourierTimeoutError. */
  track(trackingNumber: string): Promise<ProviderTrackingEvent[]>;
  /** Batalkan booking di sisi provider (G242). */
  voidBooking(providerBookingId: string, reason?: string): Promise<void>;
  /** Validasi alamat & kode pos SEBELUM quote (G229). */
  validateAddress(address: CourierAddress): Promise<AddressValidationResult>;
}
