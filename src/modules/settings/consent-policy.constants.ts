import { createHash } from 'crypto';
import { ConsentType } from '@prisma/client';

/**
 * Teks kebijakan persetujuan berversi (G085).
 *
 * Setiap pemberian/penarikan consent menyimpan `policyVersion` + `policyTextHash`
 * (SHA-256 dari teks kanonis di bawah) sebagai bukti persetujuan. Bila teks
 * kebijakan berubah, naikkan `version` — consent lama tetap merujuk versi
 * yang disetujui saat itu (tidak ditulis ulang).
 */
export interface ConsentPolicyText {
  version: string;
  title: { id: string; en: string };
  text: { id: string; en: string };
  /** Consent jenis ini tidak dapat ditarik (mis. notifikasi transaksional). */
  revocable: boolean;
}

export const CONSENT_POLICIES: Record<ConsentType, ConsentPolicyText> = {
  MARKETING_PUSH: {
    version: 'marketing.v1',
    revocable: true,
    title: { id: 'Notifikasi pemasaran (push)', en: 'Marketing notifications (push)' },
    text: {
      id: 'Saya setuju menerima notifikasi push berisi promosi, penawaran, dan informasi produk Kahade. Persetujuan ini bersifat opsional dan dapat saya tarik kapan saja melalui Pengaturan > Privasi > Persetujuan.',
      en: 'I agree to receive push notifications containing Kahade promotions, offers, and product information. This consent is optional and I may withdraw it at any time via Settings > Privacy > Consents.',
    },
  },
  MARKETING_EMAIL: {
    version: 'marketing.v1',
    revocable: true,
    title: { id: 'Email pemasaran', en: 'Marketing email' },
    text: {
      id: 'Saya setuju menerima email pemasaran berisi promosi, penawaran, dan informasi produk Kahade di alamat email terdaftar. Persetujuan ini bersifat opsional dan dapat saya tarik kapan saja melalui Pengaturan > Privasi > Persetujuan.',
      en: 'I agree to receive marketing emails containing Kahade promotions, offers, and product information at my registered email address. This consent is optional and I may withdraw it at any time via Settings > Privacy > Consents.',
    },
  },
  MARKETING_WHATSAPP: {
    version: 'marketing.v1',
    revocable: true,
    title: { id: 'Pesan pemasaran (WhatsApp)', en: 'Marketing messages (WhatsApp)' },
    text: {
      id: 'Saya setuju menerima pesan pemasaran berisi promosi dan penawaran Kahade melalui WhatsApp di nomor terdaftar. Persetujuan ini bersifat opsional dan dapat saya tarik kapan saja melalui Pengaturan > Privasi > Persetujuan.',
      en: 'I agree to receive marketing messages containing Kahade promotions and offers via WhatsApp at my registered number. This consent is optional and I may withdraw it at any time via Settings > Privacy > Consents.',
    },
  },
  TRANSACTIONAL: {
    version: 'transactional.v1',
    revocable: false,
    title: { id: 'Notifikasi transaksional', en: 'Transactional notifications' },
    text: {
      id: 'Notifikasi terkait transaksi, keamanan akun, status order, dompet, dan sengketa bersifat wajib selama akun aktif dan TIDAK dapat ditarik. Notifikasi ini diperlukan untuk menjalankan layanan dan memenuhi kewajiban keamanan.',
      en: 'Notifications related to transactions, account security, order status, wallet, and disputes are mandatory while the account is active and CANNOT be withdrawn. These notifications are required to operate the service and meet security obligations.',
    },
  },
};

/** Hash SHA-256 dari teks kanonis sebuah kebijakan (bukti integritas, G085). */
export function consentPolicyHash(type: ConsentType): string {
  const policy = CONSENT_POLICIES[type];
  return createHash('sha256')
    .update(`${policy.version}\n${policy.title.id}\n${policy.title.en}\n${policy.text.id}\n${policy.text.en}`, 'utf-8')
    .digest('hex');
}

/** Hash SHA-256 sebuah IP (G085 — IP mentah tidak pernah disimpan). */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash('sha256').update(ip, 'utf-8').digest('hex');
}

export const CONSENT_TYPES = Object.keys(CONSENT_POLICIES) as ConsentType[];
