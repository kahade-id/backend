import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DanaWebhookDisbursementService } from './dana-webhook-disbursement.service';

// DANA menandatangani notify terhadap path callback URL milik merchant —
// untuk disbursement: route lokal /v1/webhooks/dana/disbursement (req.path).
const PATH = '/v1/webhooks/dana/disbursement';

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

function makeDeps(publicPem: string) {
  const prisma = {
    webhookLog: { upsert: jest.fn(), update: jest.fn() },
    escrowDisbursement: { findUnique: jest.fn(), update: jest.fn() },
  };
  const config = {
    get: (k: string) => {
      if (k === 'dana.publicKey') return publicPem;
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

async function callNotify(
  svc: DanaWebhookDisbursementService,
  privatePem: string,
  rawBody: string,
  opts: { badSig?: boolean } = {},
) {
  const timestamp = new Date().toISOString();
  const signature = opts.badSig
    ? 'invalid'
    : signWebhook(privatePem, rawBody, timestamp);
  return svc.handleDisbursNotify(rawBody, { 'x-signature': signature, 'x-timestamp': timestamp }, PATH);
}

describe('DanaWebhookDisbursementService', () => {
  it('signature invalid → 403', async () => {
    const { publicPem, privatePem } = makeKeypair();
    const { svc } = makeDeps(publicPem);
    await expect(
      callNotify(svc, privatePem, notifyBody('REF1', '00'), { badSig: true }),
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
    });
    const out = await callNotify(svc, privatePem, notifyBody('REF-OK', '00'));
    expect(out).toEqual({ responseCode: '2004300', responseMessage: 'Successful' });
    expect(prisma.escrowDisbursement.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({ status: 'SUCCESS' }),
    });
    expect(prisma.webhookLog.update).toHaveBeenCalled();
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
    expect(prisma.escrowDisbursement.findUnique).not.toHaveBeenCalled();
  });
});
