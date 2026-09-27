import { MaintenanceMiddleware } from '../maintenance.middleware';

/**
 * Item 9 (batch 2026-09-28) — MaintenanceMiddleware.
 * - Mode off → next() untuk semua request.
 * - Mode on → 503 + Retry-After + { message } untuk non-admin.
 * - Mode on → next() untuk /v1/admin/*, /v1/public/maintenance, /v1/health.
 */
describe('MaintenanceMiddleware', () => {
  const makeRes = () => {
    const res: Record<string, jest.Mock> = {
      status: jest.fn(),
      set: jest.fn(),
      json: jest.fn(),
    };
    res.status.mockReturnValue(res);
    res.set.mockReturnValue(res);
    return res;
  };

  const mwWith = (mode: string | undefined, message?: string) =>
    new MaintenanceMiddleware({
      get: (key: string) => {
        if (key === 'MAINTENANCE_MODE') return mode;
        if (key === 'MAINTENANCE_MESSAGE') return message;
        return undefined;
      },
    } as never);

  it('melewatkan semua request saat mode off', () => {
    const mw = mwWith(undefined);
    const next = jest.fn();
    mw.use({ path: '/v1/chat/rooms' } as never, makeRes() as never, next);
    expect(next).toHaveBeenCalled();
  });

  it('melewatkan semua request saat MAINTENANCE_MODE=false', () => {
    const mw = mwWith('false');
    const next = jest.fn();
    mw.use({ path: '/v1/orders' } as never, makeRes() as never, next);
    expect(next).toHaveBeenCalled();
  });

  it('503 + Retry-After + { message } untuk request non-admin saat aktif', () => {
    const mw = mwWith('true', 'Sedang upgrade.');
    const res = makeRes();
    const next = jest.fn();
    mw.use({ method: 'GET', path: '/v1/chat/rooms' } as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.set).toHaveBeenCalledWith('Retry-After', '300');
    expect(res.json).toHaveBeenCalledWith({ message: 'Sedang upgrade.' });
  });

  it('memakai pesan default bila MAINTENANCE_MESSAGE kosong', () => {
    const mw = mwWith('true');
    const res = makeRes();
    mw.use({ method: 'GET', path: '/v1/orders/1' } as never, res as never, jest.fn());
    expect(res.json).toHaveBeenCalledWith({
      message: expect.stringContaining('maintenance'),
    });
  });

  it.each([
    '/v1/admin/ops-settings',
    '/v1/admin/maintenance',
    '/v1/admin',
    '/v1/public/maintenance',
    '/v1/health',
    '/.well-known/apple-app-site-association',
  ])('melewatkan %s saat maintenance aktif', (path) => {
    const mw = mwWith('true');
    const next = jest.fn();
    mw.use({ path } as never, makeRes() as never, next);
    expect(next).toHaveBeenCalled();
  });

  it('TIDAK melewatkan path mirip admin (/v1/adminpanel)', () => {
    const mw = mwWith('true');
    const res = makeRes();
    const next = jest.fn();
    mw.use({ path: '/v1/adminpanel' } as never, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('fail-open (next) bila baca setting melempar error', () => {
    const mw = new MaintenanceMiddleware({
      get: () => {
        throw new Error('db down');
      },
    } as never);
    const next = jest.fn();
    mw.use({ path: '/v1/chat/rooms' } as never, makeRes() as never, next);
    expect(next).toHaveBeenCalled();
  });
});
