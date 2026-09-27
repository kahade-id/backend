/**
 * courier-registry.ts — registry provider kurir (G226).
 *
 * Pemetaan kode provider → instance CourierProvider. Saat ini semua kode
 * memakai MockCourierProvider (deterministik, tanpa kredensial nyata).
 * Menambah provider API nyata = buat kelas baru yang mengimplementasikan
 * CourierProvider lalu daftarkan di sini — kode bisnis tidak berubah.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CourierProvider } from './courier-provider.interface';
import { MockCourierProvider } from './mock-courier.provider';
import { CourierConfigService, KNOWN_COURIER_CODES } from '../courier.config';

@Injectable()
export class CourierRegistry implements OnModuleInit {
  private readonly logger = new Logger(CourierRegistry.name);
  private readonly providers = new Map<string, MockCourierProvider>();

  constructor(private readonly config: CourierConfigService) {}

  onModuleInit(): void {
    for (const code of KNOWN_COURIER_CODES) {
      // TODO(integrasi nyata): ganti dengan provider API asli per kode
      // (JneApiProvider, JntApiProvider, ...) yang membaca baseUrl/apiKeyRef
      // dari CourierConfigService. Mock tetap tersedia sebagai fallback test.
      this.providers.set(code, new MockCourierProvider(code));
    }
    this.logger.log(`Courier providers registered: ${[...this.providers.keys()].join(', ')}`);
  }

  get(code: string): CourierProvider | undefined {
    return this.providers.get(code.toLowerCase());
  }

  has(code: string): boolean {
    return this.providers.has(code.toLowerCase());
  }

  listCodes(): string[] {
    return [...this.providers.keys()];
  }

  /** Akses mock untuk test/sandbox (mis. menyalakan simulateTimeout). */
  getMock(code: string): MockCourierProvider | undefined {
    return this.providers.get(code.toLowerCase());
  }
}
