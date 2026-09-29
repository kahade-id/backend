import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentPurpose, PaymentStatus } from '@prisma/client';
import { DanaWebhookSettlementService } from './dana-webhook-settlement.service';

// DANA menandatangani notify terhadap path callback URL milik merchant —
// untuk server kita: route lokal /v1/webhooks/dana/payment (req.path).
const PATH = '/v1/webhooks/dana/payment';

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
  const danaPaymentService = { getPaymentDetail: jest.fn(), refundOrder: jest.fn() };
  const walletService = { handleTopupSuccess: jest.fn() };
  const orderQrisPaymentService = { handleSettlement: jest.fn() };
  const danaDirectPaymentService = { settleEscrow: jest.fn() };
  const danaDirectRefundService = { refundPayment: jest.fn() };
  const walletMode = { isWalletEnabled: jest.fn(() => true) };
  const subscriptionsService = { activateDanaSubscription: jest.fn(async () => undefined) };
  const svc = new DanaWebhookSettlementService(
    prisma as any,
    config as unknown as ConfigService,
    danaPaymentService as any,
    walletService as any,
    orderQrisPaymentService as any,
    danaDirectPaymentService as any,
    danaDirectRefundService as any,
    walletMode as any,
    subscriptionsService as any,
  );
  return { svc, prisma, danaPaymentService, walletService, orderQrisPaymentService, danaDirectPaymentService, danaDirectRefundService, walletMode, subscriptionsService };
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
      grossAmount: BigInt(1500000),
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
      grossAmount: BigInt(1500000),
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
      grossAmount: BigInt(1500000),
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
      grossAmount: BigInt(1500000),
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

  it('DANA-direct ORDER_ESCROW: verify OK → settleEscrow TANPA wallet', async () => {
    const { svc, prisma, danaPaymentService, danaDirectPaymentService, walletService } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-dana-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.ORDER_ESCROW,
      provider: 'DANA',
      danaPayKind: 'QRIS',
      grossAmount: BigInt(1500000),
      midtransOrderId: 'PAY-DANA-1',
    });
    danaPaymentService.getPaymentDetail.mockResolvedValue({ status: 'SUCCESS', amountIdr: 15000 });
    const out = await svc.handleFinishNotify(rawBody, headers, PATH);
    expect(out.responseCode).toBe('2005600');
    expect(danaDirectPaymentService.settleEscrow).toHaveBeenCalledWith('pt-dana-1');
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
  });

  it('DANA-direct SUBSCRIPTION: verify OK → activateDanaSubscription TANPA wallet', async () => {
    const { svc, prisma, danaPaymentService, subscriptionsService, walletService } = makeDeps(publicPem);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-sub-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.SUBSCRIPTION,
      provider: 'DANA',
      danaPayKind: 'QRIS',
      grossAmount: BigInt(2990000),
      midtransOrderId: 'SUBS-DANA-1',
    });
    danaPaymentService.getPaymentDetail.mockResolvedValue({ status: 'SUCCESS', amountIdr: 29900 });
    const out = await svc.handleFinishNotify(rawBody, headers, PATH);
    expect(out.responseCode).toBe('2005600');
    expect(subscriptionsService.activateDanaSubscription).toHaveBeenCalledWith('pt-sub-1');
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
  });

  it('mode tanpa-wallet: TOPUP in-flight TIDAK dikredit — refund ke sumber', async () => {
    const { svc, prisma, danaPaymentService, walletService, danaDirectRefundService, walletMode } =
      makeDeps(publicPem);
    walletMode.isWalletEnabled.mockReturnValue(false);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-top-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.TOPUP,
      provider: 'DANA',
      danaPartnerReferenceNo: 'DANA-TOP-001',
      grossAmount: BigInt(1500000),
      midtransOrderId: 'KAHADE-TOP-1',
    });
    danaPaymentService.getPaymentDetail.mockResolvedValue({ status: 'SUCCESS', amountIdr: 15000 });
    const out = await svc.handleFinishNotify(rawBody, headers, PATH);
    expect(out.responseCode).toBe('2005600');
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
    // refund ke metode bayar asal (bukan ke wallet)
    expect(danaPaymentService.refundOrder).toHaveBeenCalledWith(
      expect.objectContaining({ partnerReferenceNo: 'DANA-TOP-001' }),
    );
    expect(danaDirectRefundService.refundPayment).not.toHaveBeenCalled(); // jalur topup pakai refund langsung
  });

  it('REGRESI (insiden 2026-09-29): triple finish-notify ASLI DANA sandbox terverifikasi', async () => {
    // Ditangkap via webhook.site 2026-09-29 22:08:36 WIB dari IP DANA
    // 147.139.135.134 — order demo "Kahade SigCap" Rp10.000.
    // DANA menandatangani terhadap path URL tujuan notifikasi
    // (/cd314adb-... = path webhook.site saat itu).
    const realBody =
      '{"amount":{"currency":"IDR","value":"10000.00"},"originalReferenceNo":"20260929111230999500166943900569349","merchantId":"216620010010042769401","latestTransactionStatus":"00","additionalInfo":{"paidTime":"2026-09-29T22:08:35+07:00","paymentInfo":{"payOptionInfos":[{"transAmount":{"currency":"IDR","value":"10000.00"},"payAmount":{"currency":"IDR","value":"10000.00"},"payMethod":"BALANCE"}],"extendInfo":"{\\"externalPromoInfos\\":[]}"}},"originalPartnerReferenceNo":"62f9bcf8-71d7-4a38-9ede-629761cd9524","createdTime":"2026-09-29T22:06:19+07:00","finishedTime":"2026-09-29T22:08:35+07:00","transactionStatusDesc":"SUCCESS"}';
    const realSignature =
      'iVlMcUpu6PMyj0x10BjFCvu7ww1bZHU6+2dZmn/1tgmOXzLTl+9RCktpJIFozQryIJOG1gBC8dRq0bRMU/6ixCKnSWWtxtMsY7y/VGfX1Mq0/D1SGqbMy67+7XAn2q+rJe41UnSrpmyU8O8zSCaGKVm1oxfdGLHH90/GxZms00r8NZcCps/cVYo5KXChreLoI9nti1Ft8PZeHR4y270a12Bmp/axHUVp0OLkJRQcjYyztgzf7zWRn7NPUUXxLDQ21/d8sJMC9JQcC9VvN2SICfUSI2P6ApRyj+ZxnohdnN9pORTCuqwdCFLRnWvPugiBFFe8qhqst/nXqTw1QfkPnA==';
    const realTimestamp = '2026-09-29T22:08:35+07:00';
    const realPath = '/cd314adb-3aec-4e1b-9b7e-e3f414f6c081';
    // Pakai public key resmi DANA (bukan keypair uji): config tanpa
    // dana.publicKey agar fallback ke DANA_SANDBOX_WEBHOOK_PUBLIC_KEY.
    const { svc, prisma } = makeDeps('');
    // Tandai duplikat agar berhenti tepat setelah verifikasi lolos —
    // bila signature invalid, sudah throw 403 sebelum menyentuh DB.
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: true });
    const out = await svc.handleFinishNotify(
      realBody,
      { 'x-signature': realSignature, 'x-timestamp': realTimestamp },
      realPath,
    );
    expect(out.responseCode).toBe('2005600');
    expect(prisma.webhookLog.upsert).toHaveBeenCalled();
  });
});
