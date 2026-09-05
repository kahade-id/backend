import { BadRequestException, CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from '../idempotency.interceptor';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

type RedisMock = {
  setNx: jest.Mock;
  get: jest.Mock;
  setex: jest.Mock;
  del: jest.Mock;
};

type LedgerMock = {
  findUnique: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  delete: jest.Mock;
};

function makeInterceptor(
  redis: RedisMock,
  ledger: LedgerMock,
  config: Record<string, unknown> = {},
) {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
  const configService = { get: jest.fn((key: string) => config[key]) };
  const prisma = { idempotencyRecord: ledger };
  return new IdempotencyInterceptor(
    reflector as never,
    redis as never,
    configService as never,
    prisma as never,
  );
}

function redisMock(): RedisMock {
  return {
    setNx: jest.fn().mockResolvedValue(true),
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
  };
}

function ledgerMock(): LedgerMock {
  return {
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'record-1' }),
    update: jest.fn().mockResolvedValue(undefined),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    delete: jest.fn().mockResolvedValue(undefined),
  };
}

const request = {
  headers: { 'idempotency-key': '550e8400-e29b-41d4-a716-446655440000' },
  user: { sub: 'user-1' },
  method: 'POST',
  originalUrl: '/v1/wallet/transfer',
};

describe('IdempotencyInterceptor', () => {
  it('requires a UUID v4 idempotency key', async () => {
    const redis = redisMock();
    const ledger = ledgerMock();
    const interceptor = makeInterceptor(redis, ledger);
    const next = { handle: jest.fn(() => of({ ok: true })) } as unknown as CallHandler;

    await expect(
      interceptor.intercept(contextFor({ headers: {}, user: { sub: 'user-1' } }), next),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('replays a completed response from the durable PostgreSQL ledger', async () => {
    const redis = redisMock();
    const ledger = ledgerMock();
    ledger.findUnique.mockResolvedValue({
      id: 'record-1',
      status: 'COMPLETED',
      responseBody: { orderId: 'ORD-1' },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const interceptor = makeInterceptor(redis, ledger);
    const next = { handle: jest.fn(() => of({ shouldNotRun: true })) } as unknown as CallHandler;

    const result = await firstValueFrom(await interceptor.intercept(contextFor(request), next));
    expect(result).toEqual({ orderId: 'ORD-1' });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('rejects reuse of a completed key with a different request payload', async () => {
    const redis = redisMock();
    const ledger = ledgerMock();
    ledger.findUnique.mockResolvedValue({
      id: 'record-1',
      status: 'COMPLETED',
      requestHash: 'hash-for-a-different-payload',
      responseBody: { transferId: 'TRF-OLD' },
      expiresAt: new Date(Date.now() + 60_000),
    });
    const interceptor = makeInterceptor(redis, ledger);
    const next = { handle: jest.fn(() => of({ transferId: 'TRF-NEW' })) } as unknown as CallHandler;

    await expect(
      interceptor.intercept(contextFor({ ...request, body: { amount: 200 } }), next),
    ).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSE' },
    });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('keeps the durable claim when response caching fails after the mutation succeeds', async () => {
    const redis = redisMock();
    redis.setex.mockRejectedValue(new Error('redis unavailable'));
    const ledger = ledgerMock();
    const interceptor = makeInterceptor(redis, ledger);
    const next = { handle: jest.fn(() => of({ transferId: 'TRF-1' })) } as unknown as CallHandler;

    const result = await firstValueFrom(await interceptor.intercept(contextFor(request), next));
    expect(result).toEqual({ transferId: 'TRF-1' });
    expect(ledger.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'record-1' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      }),
    );
    expect(ledger.delete).not.toHaveBeenCalled();
  });

  it('scopes admin idempotency by request.admin identity', async () => {
    const redis = redisMock();
    const ledger = ledgerMock();
    const interceptor = makeInterceptor(redis, ledger);
    const next = { handle: jest.fn(() => of({ ok: true })) } as unknown as CallHandler;

    await firstValueFrom(await interceptor.intercept(contextFor({
      headers: { 'idempotency-key': '550e8400-e29b-41d4-a716-446655440000' },
      admin: { sub: 'admin-42' },
      method: 'POST',
      originalUrl: '/v1/admin/system/broadcast',
    }), next));

    expect(ledger.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ scopeKey: expect.stringContaining('admin-42:POST:/v1/admin/system/broadcast:') }),
    }));
  });

  it('falls back to Redis when the database ledger is unavailable', async () => {
    const redis = redisMock();
    const ledger = ledgerMock();
    ledger.findUnique.mockRejectedValue(new Error('database unavailable'));
    redis.setNx.mockResolvedValue(false);
    redis.get.mockResolvedValue(JSON.stringify({ orderId: 'ORD-REDIS' }));
    const interceptor = makeInterceptor(redis, ledger);
    const next = { handle: jest.fn(() => of({ shouldNotRun: true })) } as unknown as CallHandler;

    const result = await firstValueFrom(
      await interceptor.intercept(
        contextFor({ ...request, originalUrl: '/v1/generic-mutation' }),
        next,
      ),
    );
    expect(result).toEqual({ orderId: 'ORD-REDIS' });
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('fails closed for Money Movement when the durable ledger is unavailable', async () => {
    const redis = redisMock();
    const ledger = ledgerMock();
    ledger.findUnique.mockRejectedValue(new Error('database unavailable'));
    const interceptor = makeInterceptor(redis, ledger);
    const next = { handle: jest.fn(() => of({ shouldRun: true })) } as unknown as CallHandler;

    await expect(interceptor.intercept(contextFor(request), next)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_SERVICE_UNAVAILABLE' },
    });
    expect(next.handle).not.toHaveBeenCalled();
  });
});
