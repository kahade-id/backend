/**
 * GAP-B1 (G090–G097): unit test redaksi ekspor data pribadi.
 *
 * Memastikan:
 * - PII lawan transaksi tidak bocor (hanya username publik),
 * - nomor rekening tidak pernah penuh (masking 4 digit terakhir),
 * - chat hanya metadata (tanpa isi pesan),
 * - pesan sengketa pihak lain dimaskir; URL bukti selalu dimaskir,
 * - balasan tiket support admin hanya metadata,
 * - fungsi tidak memutasi baris asli.
 */
import {
  maskAccountNumberTail,
  maskEmail,
  REDACTED_PLACEHOLDER,
  sanitizeChatRoomForExport,
  sanitizeDisputeForExport,
  sanitizeOrderForExport,
  sanitizeTicketReplyForExport,
  sanitizeWalletTxForExport,
} from '../export-redaction.util';

describe('maskAccountNumberTail', () => {
  it('hanya menampilkan 4 digit terakhir', () => {
    expect(maskAccountNumberTail('1234567890')).toBe('****7890');
    expect(maskAccountNumberTail('12-34-56')).toBe('****3456');
  });

  it('nilai kosong/tak valid → ****', () => {
    expect(maskAccountNumberTail(null)).toBe('****');
    expect(maskAccountNumberTail(undefined)).toBe('****');
    expect(maskAccountNumberTail('12')).toBe('****');
  });
});

describe('maskEmail', () => {
  it('menyamarkan local-part', () => {
    expect(maskEmail('budi.santoso@example.com')).toBe('b***@example.com');
  });

  it('tanpa @ → placeholder redacted', () => {
    expect(maskEmail('bukan-email')).toBe(REDACTED_PLACEHOLDER);
  });
});

describe('sanitizeOrderForExport (G090)', () => {
  const row = {
    id: 'order-1',
    buyerId: 'user-1',
    sellerId: 'user-2',
    buyer: { username: 'pembeli' },
    seller: { username: 'penjual' },
    total: 100000,
  };

  it('hanya username lawan yang disertakan — bukan PII lawan', () => {
    const out = sanitizeOrderForExport(row as never, 'user-1');
    expect(out.myRole).toBe('BUYER');
    expect(out.counterpartUsername).toBe('penjual');
    expect(out).not.toHaveProperty('buyerId');
    expect(out).not.toHaveProperty('sellerId');
    expect(out).not.toHaveProperty('buyer');
    expect(out).not.toHaveProperty('seller');
  });

  it('tidak memutasi baris asli', () => {
    const snapshot = JSON.stringify(row);
    sanitizeOrderForExport(row as never, 'user-1');
    expect(JSON.stringify(row)).toBe(snapshot);
  });
});

describe('sanitizeWalletTxForExport (G091)', () => {
  it('rekening direduksi menjadi nama bank + nomor termaskir', () => {
    const out = sanitizeWalletTxForExport({
      id: 'tx-1',
      txId: 'TX-1',
      bankAccount: { bankName: 'BCA', maskedAccountNumber: '****1234' },
      bankAccountId: 'ba-1',
      metadata: { gatewayRef: 'secret' },
    });
    expect(out.bankAccount).toEqual({ bankName: 'BCA', maskedAccountNumber: '****1234' });
    expect(out).not.toHaveProperty('bankAccountId');
    expect(out).not.toHaveProperty('metadata');
  });
});

describe('sanitizeChatRoomForExport (G092)', () => {
  it('metadata saja — tanpa isi pesan', () => {
    const out = sanitizeChatRoomForExport(
      {
        id: 'room-1',
        type: 'ORDER',
        status: 'ACTIVE',
        subject: 'Diskusi order',
        initiator: { username: 'pembeli' },
        counterpart: { username: 'penjual' },
        _count: { messages: 42 },
        createdAt: '2026-01-01',
        updatedAt: '2026-01-02',
      },
      'user-1',
      'user-2',
    );
    expect(out.roomId).toBe('room-1');
    expect(out).not.toHaveProperty('messages');
  });
});

describe('sanitizeDisputeForExport (G093)', () => {
  const row = {
    id: 'd-1',
    disputeId: 'DSP-1',
    orderId: 'order-1',
    status: 'OPEN',
    initiatedBy: 'BUYER',
    initiatorUserId: 'user-1',
    buyerClaim: 'klaim saya sebagai pembeli',
    sellerClaim: 'klaim penjual yang sensitif',
    order: { orderId: 'ORD-1' },
    decision: null,
    evidences: [
      {
        id: 'e-1',
        submittedByRole: 'SELLER',
        submittedByUserId: 'user-2',
        description: 'deskripsi bukti lawan',
        fileTypes: ['image/jpeg'],
        createdAt: '2026-01-01',
      },
    ],
    messages: [
      { id: 'm-1', senderId: 'user-1', adminId: null, message: 'pesan saya', createdAt: '2026-01-01' },
      { id: 'm-2', senderId: 'user-2', adminId: null, message: 'pesan lawan', createdAt: '2026-01-02' },
    ],
    createdAt: '2026-01-01',
    resolvedAt: null,
  };

  it('klaim sendiri penuh; klaim lawan dimaskir', () => {
    const out = sanitizeDisputeForExport(row as never, 'user-1');
    expect(out.myClaim).toBe('klaim saya sebagai pembeli');
    expect(out.otherPartyClaim).toBe(REDACTED_PLACEHOLDER);
    expect(JSON.stringify(out)).not.toContain('klaim penjual yang sensitif');
  });

  it('pesan sendiri penuh; pesan lawan dimaskir', () => {
    const out = sanitizeDisputeForExport(row as never, 'user-1');
    const messages = out.messages as Array<{ content: unknown }>;
    expect(messages[0].content).toBe('pesan saya');
    expect(messages[1].content).toBe(REDACTED_PLACEHOLDER);
  });

  it('URL bukti selalu dimaskir', () => {
    const out = sanitizeDisputeForExport(row as never, 'user-1');
    const evidences = out.evidences as Array<{ fileUrls: unknown }>;
    expect(evidences[0].fileUrls).toBe(REDACTED_PLACEHOLDER);
  });
});

describe('sanitizeTicketReplyForExport (G096)', () => {
  it('balasan admin hanya metadata — tanpa isi', () => {
    const out = sanitizeTicketReplyForExport(
      { id: 'r-1', senderType: 'ADMIN', senderId: 'admin-1', message: 'jawaban rahasia admin', createdAt: '2026-01-01' },
      'user-1',
    );
    expect(out.message).toBe(REDACTED_PLACEHOLDER);
    expect(out.sentByMe).toBe(false);
    expect(JSON.stringify(out)).not.toContain('jawaban rahasia admin');
  });

  it('balasan milik sendiri disertakan penuh', () => {
    const out = sanitizeTicketReplyForExport(
      { id: 'r-2', senderType: 'USER', senderId: 'user-1', message: 'pertanyaan saya', createdAt: '2026-01-01' },
      'user-1',
    );
    expect(out.message).toBe('pertanyaan saya');
    expect(out.sentByMe).toBe(true);
  });
});
