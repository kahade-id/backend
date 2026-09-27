/**
 * Util redaksi ekspor data pribadi (G090–G097).
 *
 * Prinsip:
 * - Data milik user sendiri (dibuat/ditujukan untuknya): disertakan penuh.
 * - PII pihak lain: diminimalkan menjadi username publik saja.
 * - Isi pesan pihak lain (admin support, pesan sengketa admin): metadata saja.
 * - Dokumen KYC & nomor rekening penuh: dikecualikan/dimaskir, dicatat di
 *   manifest bagian `excluded` beserta alasannya (G097).
 *
 * Semua fungsi di sini murni (pure) agar mudah diuji tanpa database.
 */

export const REDACTED_PLACEHOLDER = '[redacted]';

/** Samarkan nomor rekening: hanya 4 digit terakhir yang tampil. */
export function maskAccountNumberTail(plain: string | null | undefined): string {
  if (!plain) return '****';
  const digits = plain.replace(/\D/g, '');
  return digits.length >= 4 ? `****${digits.slice(-4)}` : '****';
}

/** Samarkan alamat email: s***@domain.com */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return REDACTED_PLACEHOLDER;
  const head = local.slice(0, 1) || '*';
  return `${head}***@${domain}`;
}

export interface ExportOrderRow {
  id: string;
  orderId: string;
  buyerId: string;
  sellerId: string;
  buyer?: { username: string | null } | null;
  seller?: { username: string | null } | null;
  [key: string]: unknown;
}

/**
 * G090: order milik user — sertakan username lawan saja, bukan PII lawan.
 * Mengembalikan objek baru; baris asli tidak dimutasi.
 */
export function sanitizeOrderForExport(row: ExportOrderRow, userId: string): Record<string, unknown> {
  const isBuyer = row.buyerId === userId;
  const counterpartUsername = isBuyer ? row.seller?.username ?? null : row.buyer?.username ?? null;
  const { buyerId, sellerId, buyer, seller, ...rest } = row;
  return {
    ...rest,
    myRole: isBuyer ? 'BUYER' : 'SELLER',
    counterpartUsername,
    // PII lawan (id internal, dsb.) sengaja tidak disertakan — lihat manifest.excluded.
  };
}

export interface ExportWalletTxRow {
  id: string;
  txId: string;
  bankAccount?: { bankName?: string | null; maskedAccountNumber?: string | null } | null;
  bankAccountId?: string | null;
  metadata?: unknown;
  [key: string]: unknown;
}

/**
 * G091: transaksi dompet — tanpa nomor rekening penuh; relasi bank direduksi
 * menjadi nama bank + nomor termaskir.
 */
export function sanitizeWalletTxForExport(row: ExportWalletTxRow): Record<string, unknown> {
  const { bankAccount, bankAccountId, metadata, ...rest } = row;
  const out: Record<string, unknown> = { ...rest };
  if (bankAccount) {
    out.bankAccount = {
      bankName: bankAccount.bankName ?? null,
      maskedAccountNumber: bankAccount.maskedAccountNumber ?? '****',
    };
  } else if (bankAccountId) {
    out.bankAccount = { bankName: null, maskedAccountNumber: '****' };
  }
  // metadata internal (mis. idempotency key, referensi payment gateway)
  // bukan data milik user — dicatat sebagai dikecualikan di manifest.
  return out;
}

export interface ExportChatRoomRow {
  id: string;
  type: unknown;
  status: unknown;
  subject?: string | null;
  initiator?: { username: string | null } | null;
  counterpart?: { username: string | null } | null;
  _count?: { messages?: number };
  createdAt: unknown;
  updatedAt: unknown;
}

/**
 * G092: metadata chat SAJA — tanpa isi pesan. Retensi dijelaskan di manifest.
 */
export function sanitizeChatRoomForExport(row: ExportChatRoomRow, userId: string, counterpartUserId: string | null): Record<string, unknown> {
  void userId;
  void counterpartUserId;
  return {
    roomId: row.id,
    type: row.type,
    status: row.status,
    subject: row.subject ?? null,
    participants: [row.initiator?.username ?? null, row.counterpart?.username ?? null].filter(Boolean),
    messageCount: row._count?.messages ?? 0,
    messageContentIncluded: false,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ExportDisputeRow {
  id: string;
  disputeId: string;
  orderId: string;
  order?: { orderId?: string } | null;
  initiatedBy: unknown;
  initiatorUserId: string;
  buyerClaim?: string | null;
  sellerClaim?: string | null;
  status: unknown;
  category?: unknown;
  createdAt: unknown;
  resolvedAt?: unknown;
  decision?: {
    decisionType: unknown;
    buyerAmount: unknown;
    sellerAmount: unknown;
    decisionNotes: unknown;
    isExecuted: unknown;
    executedAt: unknown;
    createdAt: unknown;
  } | null;
  evidences?: Array<{
    id: string;
    submittedByRole: string;
    submittedByUserId?: string | null;
    description?: string;
    fileTypes?: string[];
    createdAt: unknown;
  }>;
  messages?: Array<{ id: string; senderId?: string | null; adminId?: string | null; message?: string; createdAt: unknown }>;
  [key: string]: unknown;
}

/**
 * G093: sengketa — klaim milik sendiri penuh; klaim & pesan pihak lain
 * dimaskir; URL dokumen bukti dimaskir (bisa memuat KYC) — hanya metadata.
 */
export function sanitizeDisputeForExport(row: ExportDisputeRow, userId: string): Record<string, unknown> {
  const isInitiator = row.initiatorUserId === userId;
  // Klaim milik user: heuristik peran dari sisi mana user berada — bila user
  // adalah inisiator, klaimnya ada di sisi yang sesuai initiator.
  const myClaim =
    row.initiatorUserId === userId
      ? (row.initiatedBy === 'BUYER' ? row.buyerClaim : row.initiatedBy === 'SELLER' ? row.sellerClaim : (row.buyerClaim ?? row.sellerClaim))
      : REDACTED_PLACEHOLDER;

  return {
    id: row.id,
    disputeId: row.disputeId,
    orderId: row.order?.orderId ?? row.orderId,
    status: row.status,
    category: row.category ?? null,
    initiatedBy: row.initiatedBy,
    myRole: isInitiator ? 'INITIATOR' : 'RESPONDENT',
    myClaim: myClaim ?? null,
    otherPartyClaim: REDACTED_PLACEHOLDER,
    decision: row.decision
      ? {
          decisionType: row.decision.decisionType,
          buyerAmount: row.decision.buyerAmount?.toString() ?? null,
          sellerAmount: row.decision.sellerAmount?.toString() ?? null,
          decisionNotes: row.decision.decisionNotes,
          isExecuted: row.decision.isExecuted,
          executedAt: row.decision.executedAt,
          createdAt: row.decision.createdAt,
        }
      : null,
    evidences: (row.evidences ?? []).map((e) => ({
      id: e.id,
      submittedByRole: e.submittedByRole,
      submittedByMe: e.submittedByUserId === userId,
      // Deskripsi hanya bila diajukan user sendiri; URL file selalu dimaskir.
      description: e.submittedByUserId === userId ? e.description : REDACTED_PLACEHOLDER,
      fileTypes: e.fileTypes ?? [],
      fileUrls: REDACTED_PLACEHOLDER,
      createdAt: e.createdAt,
    })),
    messages: (row.messages ?? []).map((m) => {
      const sentByMe = m.senderId === userId;
      const senderType = m.adminId ? 'ADMIN' : m.senderId ? 'USER' : 'SYSTEM';
      return {
        id: m.id,
        sentByMe,
        senderType,
        // Isi pesan milik sendiri disertakan; pesan pihak lain dimaskir
        // (lihat manifest.excluded).
        content: sentByMe ? (m.message ?? null) : REDACTED_PLACEHOLDER,
        createdAt: m.createdAt,
      };
    }),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
  };
}

export interface ExportTicketReplyRow {
  id: string;
  senderType: string;
  senderId: string;
  message: string;
  createdAt: unknown;
}

/**
 * G096: tiket support — pesan milik user penuh; pesan pihak lain (admin)
 * dimaskir/diringkas: hanya metadata + penjelasan.
 */
export function sanitizeTicketReplyForExport(reply: ExportTicketReplyRow, userId: string): Record<string, unknown> {
  const isMine = reply.senderId === userId || reply.senderType === 'USER';
  if (isMine) {
    return { id: reply.id, senderType: reply.senderType, sentByMe: true, message: reply.message, createdAt: reply.createdAt };
  }
  return {
    id: reply.id,
    senderType: reply.senderType,
    sentByMe: false,
    message: REDACTED_PLACEHOLDER,
    messageNote: 'Isi pesan pihak lain (admin/support) tidak disertakan dalam ekspor demi privasi pihak tersebut.',
    createdAt: reply.createdAt,
  };
}

/** Escape satu sel CSV (RFC 4180). */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'bigint') s = value.toString();
  else s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Bangun string CSV dari header + baris objek. */
export function buildCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** Ubah BigInt menjadi sen IDR + format rupiah untuk kolom CSV yang ramah dibaca. */
export function senToIdr(sen: bigint | number | null | undefined): string {
  if (sen === null || sen === undefined) return '';
  const n = typeof sen === 'bigint' ? sen : BigInt(sen);
  return (n / 100n).toString();
}
