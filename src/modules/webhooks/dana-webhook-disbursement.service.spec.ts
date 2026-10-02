import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DanaWebhookDisbursementService } from './dana-webhook-disbursement.service';
import * as danaSnapUtil from '../payment/dana/dana-snap.util';
import {
  sha256HexLower,
  verifyDanaWebhookSignature,
} from '../payment/dana/dana-snap.util';

// DANA menandatangani notify terhadap path callback URL milik merchant —
// untuk disbursement: route lokal /v1/webhooks/dana/disbursement (req.path).
const PATH = '/v1/webhooks/dana/disbursement';
const PARTNER_ID = 'TEST-PARTNER-001';
const CHANNEL_ID = '95221';

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

function signWebhook(privatePem: string, rawBody: string, timestamp: string): string {
  const hash = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const signing = ['POST', PATH, hash, timestamp].join(':');
  const signer = cryptoSign('sha256', Buffer.from(signing, 'utf8'), {
    key: privatePem,
    padding: 1,
  });
  return signer.toString('base64');
}

function makeDeps(publicPem: string, opts: { partnerId?: string | null; channelId?: string | null } = {}) {
  const prisma = {
    webhookLog: { upsert: jest.fn(), update: jest.fn() },
    escrowDisbursement: { findUnique: jest.fn(), update: jest.fn() },
  };
  const partnerId = opts.partnerId === undefined ? PARTNER_ID : opts.partnerId;
  const channelId = opts.channelId === undefined ? CHANNEL_ID : opts.channelId;
  const config = {
    get: (k: string) => {
      if (k === 'dana.publicKey') return publicPem;
      if (k === 'dana.partnerId') return partnerId ?? '';
      if (k === 'dana.channelId') return channelId ?? '';
      return undefined;
    },
  };
  const svc = new DanaWebhookDisbursementService(
    prisma as any,
    config as unknown as ConfigService,
  );
  return { svc, prisma };
}

function notifyBody(ref: string, status: string) {
  return JSON.stringify({
    originalPartnerReferenceNo: ref,
    originalReferenceNo: `DANA-${ref}`,
    latestTransactionStatus: status,
    transactionStatusDesc: `status ${status}`,
    amount: { value: '100000.00', currency: 'IDR' },
  });
}

interface CallOpts {
  badSig?: boolean;
  partnerId?: string | null; // null = header dihilangkan
  externalId?: string | null;
  channelId?: string | null;
}

async function callNotify(
  svc: DanaWebhookDisbursementService,
  privatePem: string,
  rawBody: string,
  opts: CallOpts = {},
) {
  const timestamp = new Date().toISOString();
  const signature = opts.badSig
    ? 'invalid'
    : signWebhook(privatePem, rawBody, timestamp);
  const headers: Record<string, string | undefined> = {
    'x-signature': signature,
    'x-timestamp': timestamp,
  };
  if (opts.partnerId !== null) headers['x-partner-id'] = opts.partnerId ?? PARTNER_ID;
  if (opts.externalId !== null) headers['x-external-id'] = opts.externalId ?? 'EXT-123';
  // "CHANNEL-ID" tiba sebagai "channel-id" (Express lowercase, tanpa prefix x-).
  if (opts.channelId !== null) headers['channel-id'] = opts.channelId ?? CHANNEL_ID;
  return svc.handleDisbursNotify(
    rawBody,
    headers as Record<string, string | string[] | undefined>,
    PATH,
  );
}

/**
 * Vektor uji TETAP yang dihasilkan oleh SDK RESMI dana-python
 * (dana/webhook/webhook.py :: WebhookParser._construct_string_to_verify),
 * 2026-09-30. Membuktikan verifyDanaWebhookSignature kompatibel byte-level
 * dengan konstruksi signature resmi DANA untuk Transfer to Bank Notify —
 * bukan sekadar round-trip implementasi sendiri.
 */
const SDK_VECTOR = {
  body: '{"originalPartnerReferenceNo":"DSB-ORD20260930001","originalReferenceNo":"2026093015000001","latestTransactionStatus":"00","transactionStatusDesc":"Success","amount":{"value":"150000.00","currency":"IDR"},"beneficiaryAccountNo":"1234567890"}',
  timestamp: '2026-09-30T15:00:00+07:00',
  // string_to_verify persis dari SDK resmi — JANGAN diubah.
  stringToVerify:
    'POST:/v1/webhooks/dana/disbursement:400710136aaad8c7f9001c3c9eb2c0915c20649a758ac851d95e045ba210e271:2026-09-30T15:00:00+07:00',
  signature:
    'eej/Hz60ZXmrzbUmX+f+HqSLPwFO5Elgq9NmmU5Xrl9qlMnQJqJdcOpyju1dIwSJJEYiqBhENHJUOLDZiJtKiseCgIyqsd0pvJm7/WHdVU1jMvqcaecHpFcsNarKht6riLEk03Q9U8s8o76/R24JlL7xCIke1dr6s2KKWgZbTtZ7FSJeaUDaHVZ3GopNWWquNRCBGOeeU2cbznS8jMHloEGP6vU2hvEKx8vbNtY3hKRMggmmQIdoai1Zp0BTXCtAKwYhqQurEe6Z49nCIbUTdpm7bKrbfP6+TaSse8aX/7gVlocscJJsMHcKq9kupecDFq5UUvPxF+MuHODuPUwdDQ==',
  publicKey: `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqZL7aqKCiM5rof8zR2Y2
qMdOJFCOx71VGVi3LFLN+t1Wz/LrzQ559I+SEq7JUjDSIEGkvPewP8LpaGka9o26
zlr/DMHy54dQd5Ly6vpeHTfIvUJjMnbcjUPGUa78Ax4z8yLz42Mko53MUyWzmXCW
seQe4lx+fgOzNixCQPoOnjs8nxKjTDyzdkqwgCWCVWFdzEVELX7tfzK8bv0o5H/v
tQBcnjXY4P/qWZ8nW5y5DKH81/ID+/Hq8HQlVcWrbXXOgpyUA1FGd8ItB727ZOdI
X3EcEQYho3N/gd1yE+BRcaLcVgeXuNxElptVUI44FkUMWDPDG1l4PpU3a2/Y57MD
HwIDAQAB
-----END PUBLIC KEY-----`,
};

describe('DanaWebhookDisbursementService', () => {
  it('signature invalid → 403', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc } = makeDeps(publicPem);
    await expect(
      callNotify(svc, privatePem, notifyBody('REF1', '00'), { badSig: true }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('X-PARTNER-ID tidak cocok → 403', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc } = makeDeps(publicPem);
    await expect(
      callNotify(svc, privatePem, notifyBody('REF1', '00'), { partnerId: 'OTHER-MERCHANT' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('X-EXTERNAL-ID hilang → 403', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc } = makeDeps(publicPem);
    await expect(
      callNotify(svc, privatePem, notifyBody('REF1', '00'), { externalId: null }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('CHANNEL-ID tidak cocok → 403', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc } = makeDeps(publicPem);
    await expect(
      callNotify(svc, privatePem, notifyBody('REF1', '00'), { channelId: '00000' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dana.partnerId belum dikonfigurasi → 403 (fail-closed)', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc } = makeDeps(publicPem, { partnerId: null });
    await expect(
      callNotify(svc, privatePem, notifyBody('REF1', '00')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('status 00 → SUCCESS + balas 2004300', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc, prisma } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl1', isProcessed: false });
    prisma.escrowDisbursement.findUnique.mockResolvedValue({
      id: 'd1',
      status: 'PROCESSING',
      danaReferenceNo: null,
      amountSen: BigInt(10000000), // Rp100.000 — cocok dengan notifyBody '100000.00'
    });
    const out = await callNotify(svc, privatePem, notifyBody('REF-OK', '00'));
    expect(out).toEqual({ responseCode: '2004300', responseMessage: 'Successful' });
    expect(prisma.escrowDisbursement.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ status: 'SUCCESS' }),
    });
    expect(prisma.webhookLog.update).toHaveBeenCalledWith({
      where: { id: 'wl1' },
      data: expect.objectContaining({ isProcessed: true }),
    });
  });

  it('status 01 → PROCESSING', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc, prisma } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl2', isProcessed: false });
    prisma.escrowDisbursement.findUnique.mockResolvedValue({ id: 'd2', status: 'PENDING' });
    const out = await callNotify(svc, privatePem, notifyBody('REF-PEND', '01'));
    expect(out.responseCode).toBe('2004300');
    expect(prisma.escrowDisbursement.update).toHaveBeenCalledWith({
      where: { id: 'd2' },
      data: expect.objectContaining({ status: 'PROCESSING' }),
    });
  });

  it('status 05 → FAILED', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc, prisma } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl3', isProcessed: false });
    prisma.escrowDisbursement.findUnique.mockResolvedValue({ id: 'd3', status: 'PROCESSING' });
    const out = await callNotify(svc, privatePem, notifyBody('REF-FAIL', '05'));
    expect(out.responseCode).toBe('2004300');
    expect(prisma.escrowDisbursement.update).toHaveBeenCalledWith({
      where: { id: 'd3' },
      data: expect.objectContaining({ status: 'FAILED' }),
    });
  });

  it('status tak dikenal (09) → NEEDS_REVIEW, BUKAN FAILED', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc, prisma } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl9', isProcessed: false });
    prisma.escrowDisbursement.findUnique.mockResolvedValue({ id: 'd9', status: 'PROCESSING' });
    const out = await callNotify(svc, privatePem, notifyBody('REF-UNK', '09'));
    // Outcome bisnis tetap ack agar DANA tidak retry — keputusannya
    // ditandai untuk review manual, bukan ditebak.
    expect(out.responseCode).toBe('2004300');
    expect(prisma.escrowDisbursement.update).toHaveBeenCalledWith({
      where: { id: 'd9' },
      data: expect.objectContaining({
        status: 'NEEDS_REVIEW',
        lastError: expect.stringContaining('butuh review manual'),
      }),
    });
  });

  it('applyStatus gagal → webhook TIDAK ditandai processed (DANA boleh retry)', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc, prisma } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wlE', isProcessed: false });
    const dbError = new Error('connection reset');
    prisma.escrowDisbursement.findUnique.mockRejectedValue(dbError);
    await expect(
      callNotify(svc, privatePem, notifyBody('REF-ERR', '00')),
    ).rejects.toThrow('connection reset');
    // webhookLog.update dipanggil TAPI tanpa isProcessed: true — error
    // dicatat, retryCount naik, DANA akan retry karena respons 5xx.
    expect(prisma.webhookLog.update).toHaveBeenCalledWith({
      where: { id: 'wlE' },
      data: expect.objectContaining({
        errorMessage: expect.stringContaining('connection reset'),
        retryCount: { increment: 1 },
      }),
    });
    const updateCalls = prisma.webhookLog.update.mock.calls as unknown[][];
    for (const call of updateCalls) {
      expect((call[0] as { data: Record<string, unknown> }).data.isProcessed).not.toBe(true);
    }
  });

  it('disbursement tak dikenal → tanpa perubahan, tetap balas 2004300', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc, prisma } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl4', isProcessed: false });
    prisma.escrowDisbursement.findUnique.mockResolvedValue(null);
    const out = await callNotify(svc, privatePem, notifyBody('REF-UNKNOWN', '00'));
    expect(out.responseCode).toBe('2004300');
    expect(prisma.escrowDisbursement.update).not.toHaveBeenCalled();
  });

  it('status final tidak mundur (SUCCESS tetap SUCCESS)', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc, prisma } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl5', isProcessed: false });
    prisma.escrowDisbursement.findUnique.mockResolvedValue({ id: 'd5', status: 'SUCCESS' });
    const out = await callNotify(svc, privatePem, notifyBody('REF-FINAL', '05'));
    expect(out.responseCode).toBe('2004300');
    expect(prisma.escrowDisbursement.update).not.toHaveBeenCalled();
  });

  it('duplikat (webhookLog processed) → idempoten skip', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc, prisma } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl6', isProcessed: true });
    const out = await callNotify(svc, privatePem, notifyBody('REF-DUP', '00'));
    expect(out.responseCode).toBe('2004300');
    expect(prisma.escrowDisbursement.update).not.toHaveBeenCalled();
  });

  it('SEC-206: X-TIMESTAMP basi → 403 WEBHOOK_TIMESTAMP_STALE sebelum cek signature (walau signature valid)', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc, prisma } = makeDeps(publicPem);
    const staleBody = notifyBody('REF-STALE', '00');
    const staleTs = '2020-01-01T00:00:00+07:00';
    // Signature VALID untuk timestamp basi itu — freshness harus menolak duluan.
    const sig = signWebhook(privatePem, staleBody, staleTs);
    await expect(
      svc.handleDisbursNotify(
        staleBody,
        {
          'x-signature': sig,
          'x-timestamp': staleTs,
          'x-partner-id': PARTNER_ID,
          'x-external-id': 'EXT-1',
          'channel-id': CHANNEL_ID,
        },
        PATH,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WEBHOOK_TIMESTAMP_STALE' }),
    });
    expect(prisma.webhookLog.upsert).not.toHaveBeenCalled();
  });

  describe('kompatibilitas signature SDK resmi DANA', () => {
    // Vektor SDK resmi memakai X-TIMESTAMP fixed 2026-09-30 — signature
    // terikat pada timestamp itu sehingga tidak bisa diganti fresh.
    // Lewati freshness check SEC-206 KHUSUS untuk vektor ini (test saja,
    // bukan production).
    beforeAll(() => {
      jest.spyOn(danaSnapUtil, 'assertWebhookTimestampFresh').mockImplementation(() => undefined);
    });
    afterAll(() => {
      jest.restoreAllMocks();
    });

    it('stringToVerify byte-identik dengan dana-python WebhookParser', () => {
      const ours = `POST:${PATH}:${sha256HexLower(SDK_VECTOR.body)}:${SDK_VECTOR.timestamp}`;
      expect(ours).toBe(SDK_VECTOR.stringToVerify);
    });

    it('signature buatan SDK resmi terverifikasi oleh verifyDanaWebhookSignature', () => {
      expect(
        verifyDanaWebhookSignature({
          method: 'POST',
          path: PATH,
          rawBody: SDK_VECTOR.body,
          timestamp: SDK_VECTOR.timestamp,
          signature: SDK_VECTOR.signature,
          publicKeyPem: SDK_VECTOR.publicKey,
        }),
      ).toBe(true);
    });

    it('end-to-end: notify bertanda tangan SDK resmi diproses → SUCCESS', async () => {
      const { svc, prisma } = makeDeps(SDK_VECTOR.publicKey);
      prisma.webhookLog.upsert.mockResolvedValue({ id: 'wlSDK', isProcessed: false });
      prisma.escrowDisbursement.findUnique.mockResolvedValue({
        id: 'dSDK',
        status: 'PROCESSING',
        danaReferenceNo: null,
        amountSen: BigInt(15000000), // Rp150.000 — cocok dengan SDK_VECTOR '150000.00'
      });
      const out = await svc.handleDisbursNotify(
        SDK_VECTOR.body,
        {
          'x-signature': SDK_VECTOR.signature,
          'x-timestamp': SDK_VECTOR.timestamp,
          'x-partner-id': PARTNER_ID,
          'x-external-id': 'EXT-SDK-1',
          'channel-id': CHANNEL_ID,
        },
        PATH,
      );
      expect(out.responseCode).toBe('2004300');
      expect(prisma.escrowDisbursement.update).toHaveBeenCalledWith({
        where: { id: 'dSDK' },
        data: expect.objectContaining({ status: 'SUCCESS' }),
      });
    });
  });
});
