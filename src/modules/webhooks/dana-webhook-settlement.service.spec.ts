import { createHash, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentPurpose, PaymentStatus } from '@prisma/client';
import { DanaWebhookSettlementService } from './dana-webhook-settlement.service';
import * as danaSnapUtil from '../payment/dana/dana-snap.util';

// Tangkap implementasi ASLI sebelum spyOn di bawah menimpa export —
// (import binding bersifat live; mengambilnya setelah spyOn akan
// mengembalikan mock itu sendiri → rekursi tak berujung.)
const realAssertWebhookTimestampFresh = danaSnapUtil.assertWebhookTimestampFresh;

// SEC-206: sebagian besar test memakai X-TIMESTAMP fixed 2026-09-29
// (termasuk vektor SDK resmi — signature terikat timestamp, tidak bisa
// diganti fresh). Lewati freshness check di test-test itu; perilaku
// freshness diuji eksplisit pada describe SEC-206 di bawah.
const freshnessMock = jest.spyOn(danaSnapUtil, 'assertWebhookTimestampFresh');

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

function makeDeps(
  publicPem: string,
  opts: { danaEnv?: string; test500Once?: string; merchantId?: string } = {},
) {
  const prisma = {
    webhookLog: { upsert: jest.fn(), update: jest.fn() },
    paymentTransaction: { findUnique: jest.fn(), update: jest.fn() },
  };
  const config = {
    get: (k: string) => {
      if (k === 'dana.publicKey') return publicPem;
      if (k === 'dana.env') return opts.danaEnv ?? 'sandbox';
      if (k === 'dana.merchantId') return opts.merchantId ?? 'M-1';
      if (k === 'DANA_WEBHOOK_TEST_5005601_ONCE') return opts.test500Once;
      return undefined;
    },
  };
  const danaPaymentService = { getPaymentDetail: jest.fn(), refundOrder: jest.fn() };
  const walletService = { handleTopupSuccess: jest.fn() };
  const orderQrisPaymentService = { handleSettlement: jest.fn() };
  const danaDirectPaymentService = { settleEscrow: jest.fn() };
  const danaDirectRefundService = { refundPayment: jest.fn(), refundAmount: jest.fn() };
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

  beforeEach(() => {
    jest.clearAllMocks();
    freshnessMock.mockImplementation(() => undefined);
  });

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
    // SYS-B-201: cabang TOPUP return awal — handleTopupSuccess menandai
    // SUCCESS sendiri; tail update SUCCESS generik TIDAK boleh jalan.
    expect(prisma.paymentTransaction.update).not.toHaveBeenCalled();
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

  it('SYS-B-202: status final-gagal DANA (04) → payment PENDING dipersist FAILED (bukan macet PENDING)', async () => {
    const { svc, prisma, danaPaymentService } = makeDeps(publicPem);
    const failedBody = JSON.stringify({ ...notifyBody, latestTransactionStatus: '04' });
    const failedSig = signWebhook(privatePem, failedBody, timestamp);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.TOPUP,
      grossAmount: BigInt(1500000),
      midtransOrderId: 'KAHADE-TOP-1',
    });
    const out = await svc.handleFinishNotify(
      failedBody,
      { 'x-signature': failedSig, 'x-timestamp': timestamp },
      PATH,
    );
    expect(out.responseCode).toBe('2005600');
    expect(danaPaymentService.getPaymentDetail).not.toHaveBeenCalled();
    expect(prisma.paymentTransaction.update).toHaveBeenCalledWith({
      where: { id: 'pt-1' },
      data: { status: PaymentStatus.FAILED, failedAt: expect.any(Date) },
    });
  });

  it('SYS-B-202: guard PENDING→FAILED — payment yang sudah final TIDAK diturunkan statusnya', async () => {
    const { svc, prisma } = makeDeps(publicPem);
    const failedBody = JSON.stringify({ ...notifyBody, latestTransactionStatus: '07' });
    const failedSig = signWebhook(privatePem, failedBody, timestamp);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-1',
      status: PaymentStatus.SUCCESS, // sudah final
      purpose: PaymentPurpose.TOPUP,
      grossAmount: BigInt(1500000),
      midtransOrderId: 'KAHADE-TOP-1',
    });
    const out = await svc.handleFinishNotify(
      failedBody,
      { 'x-signature': failedSig, 'x-timestamp': timestamp },
      PATH,
    );
    expect(out.responseCode).toBe('2005600');
    expect(prisma.paymentTransaction.update).not.toHaveBeenCalled();
  });

  it('SYS-B-204: merchantId notify tidak cocok dengan config → 403 WEBHOOK_MERCHANT_ID_MISMATCH', async () => {
    const { svc, prisma } = makeDeps(publicPem, { merchantId: 'M-OTHER' });
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.TOPUP,
      grossAmount: BigInt(1500000),
      midtransOrderId: 'KAHADE-TOP-1',
    });
    await expect(svc.handleFinishNotify(rawBody, headers, PATH)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WEBHOOK_MERCHANT_ID_MISMATCH' }),
    });
    // Properti keamanan yang dikunci: TIDAK ADA perubahan settlement
    // (paymentTransaction.update tidak dipanggil). webhookLog.update BOLEH
    // dipanggil — itu bookkeeping error SEC-202 (catat errorMessage +
    // retryCount), bukan pergerakan uang.
    expect(prisma.paymentTransaction.update).not.toHaveBeenCalled();
  });

  it('SYS-B-406: env non-sandbox tanpa DANA_PUBLIC_KEY → tolak verifikasi (fail-closed, 503)', async () => {
    const { svc } = makeDeps('', { danaEnv: 'production' });
    await expect(svc.handleFinishNotify(rawBody, headers, PATH)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'DANA_WEBHOOK_KEY_UNCONFIGURED' }),
    });
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

  it('REGRESI (insiden 2026-09-29): payload finish-notify ASLI DANA sandbox', async () => {
    // Struktur payload asli ditangkap via webhook.site 2026-09-29 22:08:36 WIB
    // dari IP DANA 147.139.135.134 — order demo "Kahade SigCap" Rp10.000.
    // Signature asli TIDAK dicantumkan di repo (aturan keamanan) — di sini
    // pakai placeholder agar test memastikan fail-closed (403 + tanpa DB
    // write) untuk signature yang tidak cocok. Bukti jalur positif (signature
    // asli terverifikasi dengan path tujuan + public key resmi DANA) sudah
    // dijalankan offline dan terdokumentasi di laporan insiden.
    const realBody =
      '{"amount":{"currency":"IDR","value":"10000.00"},"originalReferenceNo":"20260929111230999500166943900569349","merchantId":"216620010010042769401","latestTransactionStatus":"00","additionalInfo":{"paidTime":"2026-09-29T22:08:35+07:00","paymentInfo":{"payOptionInfos":[{"transAmount":{"currency":"IDR","value":"10000.00"},"payAmount":{"currency":"IDR","value":"10000.00"},"payMethod":"BALANCE"}]}},"originalPartnerReferenceNo":"62f9bcf8-71d7-4a38-9ede-629761cd9524","createdTime":"2026-09-29T22:06:19+07:00","finishedTime":"2026-09-29T22:08:35+07:00","transactionStatusDesc":"SUCCESS"}';
    const realPath = '/cd314adb-3aec-4e1b-9b7e-e3f414f6c081'; // path URL tujuan notify saat capture
    const { svc, prisma } = makeDeps('');
    await expect(
      svc.handleFinishNotify(
        realBody,
        { 'x-signature': 'PLACEHOLDER-BUKAN-SIGNATURE-ASLI', 'x-timestamp': '2026-09-29T22:08:35+07:00' },
        realPath,
      ),
    ).rejects.toThrow('Invalid DANA webhook signature');
    expect(prisma.webhookLog.upsert).not.toHaveBeenCalled(); // fail-closed: tanpa DB write
  });

  describe('test hook 5005601 (sandbox-only, satu kali)', () => {
    it('fire 5005601 sekali lalu otomatis nonaktif — tanpa DB write', async () => {
      const { svc, prisma } = makeDeps(publicPem, { danaEnv: 'sandbox', test500Once: 'true' });
      prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
      // Fire pertama: 5005601
      const out1 = await svc.handleFinishNotify(rawBody, headers, PATH);
      expect(out1.responseCode).toBe('5005601');
      expect(out1.responseMessage).toBe('Internal Server Error');
      expect(prisma.webhookLog.upsert).not.toHaveBeenCalled(); // tanpa DB write
      // Retry berikutnya: hook sudah nonaktif → diproses normal (ack 2005600)
      prisma.paymentTransaction.findUnique.mockResolvedValue(null);
      const out2 = await svc.handleFinishNotify(rawBody, headers, PATH);
      expect(out2.responseCode).toBe('2005600');
      expect(prisma.webhookLog.upsert).toHaveBeenCalledTimes(1);
    });

    it('hook mati bila env flag tidak true', async () => {
      const { svc, prisma } = makeDeps(publicPem, { danaEnv: 'sandbox' });
      prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
      prisma.paymentTransaction.findUnique.mockResolvedValue(null);
      const out = await svc.handleFinishNotify(rawBody, headers, PATH);
      expect(out.responseCode).toBe('2005600');
    });

    it('hook mati total di production walau flag true', async () => {
      const { svc, prisma } = makeDeps(publicPem, { danaEnv: 'production', test500Once: 'true' });
      prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
      prisma.paymentTransaction.findUnique.mockResolvedValue(null);
      const out = await svc.handleFinishNotify(rawBody, headers, PATH);
      expect(out.responseCode).toBe('2005600');
    });

    it('signature invalid tetap 403 — hook tidak fire', async () => {
      const { svc, prisma } = makeDeps(publicPem, { danaEnv: 'sandbox', test500Once: 'true' });
      await expect(
        svc.handleFinishNotify(rawBody, { 'x-signature': 'salah', 'x-timestamp': timestamp }, PATH),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.webhookLog.upsert).not.toHaveBeenCalled();
    });

    it('hook hanya fire di notif 00 — notif 05 tetap 2005600', async () => {
      const { svc, prisma } = makeDeps(publicPem, { danaEnv: 'sandbox', test500Once: 'true' });
      prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
      prisma.paymentTransaction.findUnique.mockResolvedValue(null);
      // Notif 05 (expired): hook TIDAK boleh fire — balas normal 2005600.
      // Body 05 harus di-sign ulang karena signature mengikat isi body.
      const body05 = JSON.stringify({ ...notifyBody, latestTransactionStatus: '05' });
      const sig05 = signWebhook(privatePem, body05, timestamp);
      const out = await svc.handleFinishNotify(
        body05,
        { 'x-signature': sig05, 'x-timestamp': timestamp },
        PATH,
      );
      expect(out.responseCode).toBe('2005600');
      expect(prisma.webhookLog.upsert).toHaveBeenCalledTimes(1);
    });
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

  it('mode tanpa-wallet: TOPUP in-flight TIDAK dikredit — refund ke sumber via primitif kanonis (SYS-B-103)', async () => {
    const { svc, prisma, danaPaymentService, walletService, danaDirectRefundService, walletMode } =
      makeDeps(publicPem);
    walletMode.isWalletEnabled.mockReturnValue(false);
    prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: false });
    prisma.paymentTransaction.findUnique.mockResolvedValue({
      id: 'pt-top-1',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.TOPUP,
      provider: 'DANA',
      danaPayKind: 'QRIS',
      danaPartnerReferenceNo: 'DANA-TOP-001',
      grossAmount: BigInt(1500000),
      midtransOrderId: 'KAHADE-TOP-1',
    });
    danaPaymentService.getPaymentDetail.mockResolvedValue({ status: 'SUCCESS', amountIdr: 15000 });
    danaDirectRefundService.refundAmount.mockResolvedValue({
      refunded: true,
      already: false,
      amountSen: BigInt(1500000),
    });
    const out = await svc.handleFinishNotify(rawBody, headers, PATH);
    expect(out.responseCode).toBe('2005600');
    expect(walletService.handleTopupSuccess).not.toHaveBeenCalled();
    // SYS-B-103: refund topup lewat primitif kanonis (attempt durable +
    // refundedAmount) — BUKAN refundOrder mentah.
    expect(danaDirectRefundService.refundAmount).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentDbId: 'pt-top-1',
        idempotencyKey: 'TOPUP:pt-top-1:NOWALLET',
      }),
    );
    expect(danaPaymentService.refundOrder).not.toHaveBeenCalled();
    // SYS-B-201: cabang TOPUP return awal — tail update SUCCESS generik TIDAK
    // boleh jalan (payment ditandai REFUNDED oleh primitif refund).
    expect(prisma.paymentTransaction.update).not.toHaveBeenCalled();
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

  describe('SEC-206: freshness X-TIMESTAMP (±5 menit)', () => {
    it('timestamp basi (>5 menit) → 403 WEBHOOK_TIMESTAMP_STALE SEBELUM cek signature', async () => {
      const { svc } = makeDeps(publicPem);
      // Pakai implementasi asli (bukan mock no-op) untuk test ini.
      freshnessMock.mockImplementation(realAssertWebhookTimestampFresh);
      await expect(
        svc.handleFinishNotify(
          rawBody,
          { 'x-signature': 'apapun', 'x-timestamp': '2020-01-01T00:00:00+07:00' },
          PATH,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'WEBHOOK_TIMESTAMP_STALE' }),
      });
    });

    it('timestamp fresh + signature invalid → tetap 403 WEBHOOK_SIGNATURE_INVALID (freshness lolos dulu)', async () => {
      const { svc, prisma } = makeDeps(publicPem);
      freshnessMock.mockImplementation(realAssertWebhookTimestampFresh);
      const fresh = new Date().toISOString();
      // Signature bogus dengan timestamp fresh → freshness lolos, RSA yang menolak.
      await expect(
        svc.handleFinishNotify(rawBody, { 'x-signature': 'bogus', 'x-timestamp': fresh }, PATH),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'WEBHOOK_SIGNATURE_INVALID' }),
      });
      expect(prisma.webhookLog.upsert).not.toHaveBeenCalled();
      // Signature valid + timestamp fresh → lolos ke pipeline normal.
      const freshSig = signWebhook(privatePem, rawBody, fresh);
      prisma.webhookLog.upsert.mockResolvedValue({ id: 'wl-1', isProcessed: true });
      const out = await svc.handleFinishNotify(
        rawBody,
        { 'x-signature': freshSig, 'x-timestamp': fresh },
        PATH,
      );
      expect(out.responseCode).toBe('2005600');
    });
  });
});
