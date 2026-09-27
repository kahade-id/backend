import { ReceiptsController } from '../receipts.controller';
import { ReceiptsService } from '../receipts.service';
import { ReceiptKind } from '../dto/create-receipt-token.dto';

const validResult = {
  valid: true as const,
  kind: ReceiptKind.WALLET_TX,
  status: 'SUCCESS',
  amount: '25000000',
  currency: 'IDR' as const,
  occurredAt: '2026-09-20T10:00:00.000Z',
};

function fakeRes() {
  return { setHeader: jest.fn(), status: jest.fn() } as any;
}

describe('ReceiptsController (content negotiation)', () => {
  let controller: ReceiptsController;
  let service: { verifyToken: jest.Mock; createToken: jest.Mock; renderReceiptHtml: jest.Mock };

  beforeEach(() => {
    const real = new ReceiptsService({} as any, {
      get: () => undefined,
    } as any);
    service = {
      verifyToken: jest.fn(),
      createToken: jest.fn(),
      // Pakai render HTML asli agar isi halaman ikut teruji
      renderReceiptHtml: jest.fn((r: any) => real.renderReceiptHtml(r)),
    };
    controller = new ReceiptsController(service as unknown as ReceiptsService);
  });

  it('Accept: application/json + token valid → JSON 200', async () => {
    service.verifyToken.mockResolvedValue(validResult);
    const res = fakeRes();
    const body = await controller.verify(
      'tok',
      { headers: { accept: 'application/json' } } as any,
      res,
    );
    expect(body).toEqual(validResult);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.setHeader).not.toHaveBeenCalledWith('Content-Type', expect.stringContaining('text/html'));
  });

  it('Accept: application/json + token invalid → JSON 404 { valid: false }', async () => {
    service.verifyToken.mockResolvedValue({ valid: false });
    const res = fakeRes();
    const body = await controller.verify('tok', { headers: { accept: 'application/json' } } as any, res);
    expect(body).toEqual({ valid: false });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('Accept: text/html + token valid → halaman HTML "Struk valid"', async () => {
    service.verifyToken.mockResolvedValue(validResult);
    const res = fakeRes();
    const body = await controller.verify(
      'tok',
      { headers: { accept: 'text/html,application/xhtml+xml' } } as any,
      res,
    );
    expect(typeof body).toBe('string');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/html; charset=utf-8');
    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(body as string).toContain('Struk valid');
    expect(body as string).toContain('Rp 250.000');
  });

  it('Accept: text/html + token invalid → halaman 404 "tidak ditemukan"', async () => {
    service.verifyToken.mockResolvedValue({ valid: false });
    const res = fakeRes();
    const body = await controller.verify('tok', { headers: { accept: 'text/html' } } as any, res);
    expect(typeof body).toBe('string');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(body as string).toContain('tidak ditemukan');
  });

  it('tanpa header Accept → default JSON', async () => {
    service.verifyToken.mockResolvedValue(validResult);
    const res = fakeRes();
    const body = await controller.verify('tok', { headers: {} } as any, res);
    expect(body).toEqual(validResult);
  });

  it('createToken meneruskan userId dari JWT ke service', async () => {
    service.createToken.mockResolvedValue({ token: 't', verifyUrl: 'u' });
    const dto = { kind: ReceiptKind.TOPUP, referenceId: 'pay-1' } as any;
    const out = await controller.createToken('user-42', dto);
    expect(service.createToken).toHaveBeenCalledWith('user-42', dto);
    expect(out).toEqual({ token: 't', verifyUrl: 'u' });
  });
});
