import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentPurpose, PaymentStatus } from '@prisma/client';
import { DanaWebhookSettlementService, DANA_FINISH_NOTIFY_API_PATH } from './dana-webhook-settlement.service';

// Signature webhook DANA dihitung terhadap path API DANA, bukan route lokal.
const PATH = DANA_FINISH_NOTIFY_API_PATH;

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
    paymentTransaction: { findUnique: jest.fn(), update: jest.fn() },
  };
  const config = { get: (k: string) => (k === 'dana.publicKey' ? publicPem : undefined) };
  const danaPaymentService = { getPaymentDetail: jest.fn() };
  const walletService = { handleTopupSuccess: jest.fn() };
  const orderQrisPaymentService = { handleSettlement: jest.fn() };
  const svc = new DanaWebhookSettlementService(
    prisma as any,
    config as unknown as ConfigService,
    danaPaymentService as any,
    walletService as any,
    orderQrisPaymentService as any,
  );
  return { svc, prisma, danaPaymentService, walletService, orderQrisPaymentService };
}

const notifyBody = {
  responseCode: '2005100',
  responseMessage: 'Successful',
  originalPartnerReferenceNo: 'DANA-TOP-001',
  originalReferenceNo: 'DANA-REF-9',
  merchantId: 'M-1',
  latestTransactionStatus: '00',
  transactionStatusDesc: 'Paid',
  amount: { value: '15000.00', currency: 'IDR' },
  additionalInfo: { paymentInfo: { paidTime: '2026-09-29T18:00:00+07:00' } },
};

describe('dana-webhook-settlement.service', () => {
  const { publicPem, privatePem } = makeKeypair();
  const timestamp = '2026-09-29T18:00:01+07:00';
  const rawBody = JSON.stringify(notifyBody);
  const signature = signWebhook(privatePem, rawBody, timestamp);
  const headers = { 'x-signature': signature, 'x-timestamp': timestamp };

  beforeEach(() => jest.clearAllMocks());

  it('menolak signature invalid (403) tanpa menyentuh DB', async () => {
    const { svc, prisma } = makeDeps(publicPem);
    await expect(
      svc.handleFinishNotify(rawBody, { ...headers, 'x-signature': 'bogus' }, PATH),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.webhookLog.upsert).not.toHaveBeenCalled();
  });

  it('idempoten: notify duplikat tidak settlement dua kali', async () => {
    const { svc, prisma, walletService } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: true });
    const out = await svc.handleFinishNotify(rawBody, headers, PATH);
    expect(out.responseCode).toBe('2005600');
    expect(prisma.paymentTransaction.findUnique).not.toHaveBeenCalled();
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
    expect(prisma.webhookLog.update).not.toHaveBeenCalled();
  });

  it('TOPUP sukses: verify-via-API + nominal cocok → settlement wallet', async () => {
    const { svc, prisma, danaPaymentService, walletService } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.TOPUP,
      grossAmount: BigInt(15000),
      midtransOrderId: 'KAHADE-TOP-1',
    });
    danaPaymentService.getPaymentDetail.mockResolvedValue({
      status: 'SUCCESS',
      amountIdr: 15000,
    });
    const out = await svc.handleFinishNotify(rawBody, headers, PATH);
    expect(out.responseCode).toBe('2005600');
    expect(danaPaymentService.getPaymentDetail).toHaveBeenCalledWith('DANA-TOP-001');
    expect(walletService.handleTopupSuccess).toHaveBeenCalledTimes(1);
    expect(walletService.handleTopupSuccess).toHaveBeenCalledWith('KAHADE-TOP-1', '15000');
    expect(prisma.paymentTransaction.update).toHaveBeenCalledWith({
      where: { id: 'pt-1' },
      data: { status: PaymentStatus.SUCCESS, danaReferenceNo: 'DANA-REF-9' },
    });
    expect(prisma.webhookLog.update).toHaveBeenCalled();
  });

  it('fail-closed: nominal verify-via-API mismatch → JANGAN kredit', async () => {
    const { svc, prisma, danaPaymentService, walletService } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.TOPUP,
      grossAmount: BigInt(15000),
      midtransOrderId: 'KAHADE-TOP-1',
    });
    danaPaymentService.getPaymentDetail.mockResolvedValue({
      status: 'SUCCESS',
      amountIdr: 99999, // mismatch!
    });
    const out = await svc.handleFinishNotify(rawBody, headers, PATH);
    expect(out.responseCode).toBe('2005600');
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.update).not.toHaveBeenCalled();
  });

  it('fail-closed: verify-via-API UNKNOWN → JANGAN kredit', async () => {
    const { svc, prisma, danaPaymentService, walletService } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.ORDER_ESCROW,
      grossAmount: BigInt(15000),
      midtransOrderId: 'KAHADE-ORD-1',
    });
    danaPaymentService.getPaymentDetail.mockResolvedValue({ status: 'UNKNOWN', amountIdr: null });
    await svc.handleFinishNotify(rawBody, headers, PATH);
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.update).not.toHaveBeenCalled();
  });

  it('status non-sukses DANA (mis. expired) → tanpa settlement', async () => {
    const { svc, prisma, danaPaymentService, walletService } = makeDeps(publicPem);
    const expiredBody = JSON.stringify({ ...notifyBody, latestTransactionStatus: '05' });
    const expiredSig = signWebhook(privatePem, expiredBody, timestamp);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.TOPUP,
      grossAmount: BigInt(15000),
      midtransOrderId: 'KAHADE-TOP-1',
    });
    await svc.handleFinishNotify(
      expiredBody,
      { 'x-signature': expiredSig, 'x-timestamp': timestamp },
      PATH,
    );
    expect(danaPaymentService.getPaymentDetail).not.toHaveBeenCalled();
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
  });

  it('partnerReferenceNo tak dikenal (notify uji portal) → ack tanpa settlement', async () => {
    const { svc, prisma, walletService } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue(null);
    const out = await svc.handleFinishNotify(rawBody, headers, PATH);
    expect(out.responseCode).toBe('2005600');
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
    expect(prisma.webhookLog.update).toHaveBeenCalled(); // tetap ditandai processed
  });
});
