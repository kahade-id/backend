/**
 * Kahade — metrik koneksi WebSocket realtime (G493 audit 2026-09-26).
 *
 * Diinstrumentasi dari RealtimeGateway (handleConnection/handleDisconnect):
 *   - koneksi aktif saat ini,
 *   - total connect/disconnect kumulatif proses ini,
 *   - reconnect per versi aplikasi (klien mengirim `appVersion` di
 *     handshake auth/query — versi "unknown" bila tidak dikirim).
 *
 * Pola penyimpanan: state di level MODUL (bukan instance) + fungsi polos
 * `wsOnConnect`/`wsOnDisconnect`/`getWsSnapshot`, sehingga gateway bisa
 * mencatat TANPA injeksi DI dan TANPA risiko dependensi sirkular.
 * Kelas @Injectable mendelegasikan ke state yang sama untuk endpoint admin.
 *
 * In-memory per worker (multi-worker: agregat di halaman admin menjumlah
 * dari tiap worker bila diperlukan — untuk sekarang satu angka per worker
 * + label worker di response).
 *
 * TIDAK menyimpan userId/IP — hanya counter agregat per versi aplikasi.
 * `lastDisconnect` menyimpan userId SEMENTARA (maks 10k, hanya timestamp)
 * untuk deteksi reconnect; tidak diekspos ke endpoint mana pun.
 */
import { Injectable } from '@nestjs/common';

export interface WsMetricsSnapshot {
  worker: string;
  activeConnections: number;
  totalConnects: number;
  totalDisconnects: number;
  /** Reconnect (connect ke-2+ dalam 60 dtk setelah disconnect) per versi app. */
  reconnectsByAppVersion: Record<string, number>;
  connectsByAppVersion: Record<string, number>;
  at: string;
}

const RECONNECT_WINDOW_MS = 60_000;

let active = 0;
let totalConnects = 0;
let totalDisconnects = 0;
const connectsByVersion = new Map<string, number>();
const reconnectsByVersion = new Map<string, number>();
/** socketId → { version, connectedAt } untuk deteksi reconnect. */
const sockets = new Map<string, { version: string; connectedAt: number }>();
/** userId → disconnect terakhir (epoch ms) — tanpa menyimpan identitas lama. */
const lastDisconnect = new Map<string, number>();

/** Normalisasi versi: hanya pola angka-titik yang lolos, sisanya "unknown". */
function sanitizeVersion(raw: string | undefined): string {
  if (typeof raw === 'string' && /^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/.test(raw.trim())) {
    return raw.trim();
  }
  return 'unknown';
}

/** Dipanggil saat socket terhubung (dari RealtimeGateway.handleConnection). */
export function wsOnConnect(
  socketId: string,
  userId: string | undefined,
  appVersion: string | undefined,
): void {
  const version = sanitizeVersion(appVersion);
  active += 1;
  totalConnects += 1;
  sockets.set(socketId, { version, connectedAt: Date.now() });
  connectsByVersion.set(version, (connectsByVersion.get(version) ?? 0) + 1);
  if (userId) {
    const last = lastDisconnect.get(userId);
    if (last && Date.now() - last < RECONNECT_WINDOW_MS) {
      reconnectsByVersion.set(version, (reconnectsByVersion.get(version) ?? 0) + 1);
    }
    lastDisconnect.delete(userId);
  }
}

/** Dipanggil saat socket terputus (dari RealtimeGateway.handleDisconnect). */
export function wsOnDisconnect(socketId: string, userId: string | undefined): void {
  if (sockets.delete(socketId)) {
    active = Math.max(0, active - 1);
  }
  totalDisconnects += 1;
  if (userId) {
    lastDisconnect.set(userId, Date.now());
    // Batasi map agar tidak tumbuh tanpa batas (10k user terakhir cukup).
    if (lastDisconnect.size > 10_000) {
      const oldest = [...lastDisconnect.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) lastDisconnect.delete(oldest[0]);
    }
  }
}

/** Snapshot agregat (untuk endpoint admin). */
export function getWsSnapshot(): WsMetricsSnapshot {
  return {
    worker: process.pid.toString(),
    activeConnections: active,
    totalConnects,
    totalDisconnects,
    reconnectsByAppVersion: Object.fromEntries(reconnectsByVersion),
    connectsByAppVersion: Object.fromEntries(connectsByVersion),
    at: new Date().toISOString(),
  };
}

@Injectable()
export class WsMetricsService {
  onConnect(socketId: string, userId: string | undefined, appVersion: string | undefined): void {
    wsOnConnect(socketId, userId, appVersion);
  }

  onDisconnect(socketId: string, userId: string | undefined): void {
    wsOnDisconnect(socketId, userId);
  }

  snapshot(): WsMetricsSnapshot {
    return getWsSnapshot();
  }
}
