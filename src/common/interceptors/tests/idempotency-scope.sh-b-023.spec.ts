
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { IdempotencyInterceptor } from '../idempotency.interceptor';

function contextFor(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/**
 * SH-B-023: cakupan idempotency mencakup actor + HTTP method + path + key
 * (+ body fingerprint). Hide/unhide dengan Idempotency-Key yang sama tidak
 * boleh replay silang — keduanya adalah mutasi berbeda pada path berbeda.
 */
describe('IdempotencyInterceptor — SH-B-023 scope actor+method+path+key', () => {
  const idempotencyKey = '550e8400-e29b-41d4-a716-446655440000';
  const commentId = 'cccc00000000000000001';
  const hidePath = `/v1/showcase/comments/${commentId}/hide`;
  const unhidePath = `/v1/showcase/comments/${commentId}/unhide`;

  function makeRequest(path: string, userId = 'user-1', method = 'POST') {
    return {
      headers: { 'idempotency-key': idempotencyKey },
      user: { sub: userId },
      method,
      originalUrl: path,
      body: {},
    };
  }

  function makeInterceptorWith(records: Map<string, any>) {
    const ledger = {
      findUnique: jest.fn(async ({ where }: any) => records.get(where.scopeKey) ?? null),
      create: jest.fn(async ({ data }: any) => {
        records.set(data.scopeKey, {
          ...data,
          id: `record-${data.scopeKey}`,
          status: 'IN_FLIGHT',
          expiresAt: new Date(Date.now() + 3600_000),
        });
        return { id: `record-${data.scopeKey}` };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        for (const [scopeKey, row] of records) {
          if (row.id === where.id) {
            records.set(scopeKey, { ...row, ...data });
            return records.get(scopeKey);
          }
        }
        return null;
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const redis = {
      setNx: jest.fn().mockResolvedValue(true),
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(true) };
    const configService = { get: jest.fn(() => undefined) };
    const interceptor = new IdempotencyInterceptor(
      reflector as never,
      redis as never,
      configService as never,
      { idempotencyRecord: ledger } as never,
    );
    return { records, interceptor };
  }

  async function run(
    interceptor: IdempotencyInterceptor,
    req: Record<string, unknown>,
    body: unknown,
  ) {
    const next = { handle: jest.fn(() => of(body)) } as unknown as CallHandler;
    const result = await firstValueFrom(await interceptor.intercept(contextFor(req), next));
    return { result, next };
  }

  it('sama key pada hide dan unhide: keduanya dieksekusi, bukan replay silang', async () => {
    const { interceptor, records } = makeInterceptorWith(new Map());

    const hide = await run(interceptor, makeRequest(hidePath), { hidden: true });
    expect(hide.next.handle).toHaveBeenCalledTimes(1);
    expect(hide.result).toEqual({ hidden: true });

    const unhide = await run(interceptor, makeRequest(unhidePath), { hidden: false });
    expect(unhide.next.handle).toHaveBeenCalledTimes(1);
    expect(unhide.result).toEqual({ hidden: false });

    // Dua scopeKey berbeda tercatat: path menjadi bagian scope.
    expect(records.size).toBe(2);
    expect([...records.keys()]).toEqual(
      expect.arrayContaining([
        `user-1:POST:${hidePath}:${idempotencyKey}`,
        `user-1:POST:${unhidePath}:${idempotencyKey}`,
      ]),
    );
  });

  it('hide yang sudah selesai tidak membuat unhide direplay (dan sebaliknya)', async () => {
    const hideScopeKey = `user-1:POST:${hidePath}:${idempotencyKey}`;
    const unhideScopeKey = `user-1:POST:${unhidePath}:${idempotencyKey}`;
    const records = new Map<string, any>([
      [
        hideScopeKey,
        {
          id: 'record-hide',
          scopeKey: hideScopeKey,
          key: idempotencyKey,
          userId: 'user-1',
          requestHash: null, // skip fingerprint check — seed untuk pengujian scope.
          status: 'COMPLETED',
          responseBody: { hidden: true },
          expiresAt: new Date(Date.now() + 3600_000),
        },
      ],
    ]);
    const { interceptor } = makeInterceptorWith(records);

    // Hide dengan key yang sama: direplay (key reuse pada operasi yang sama).
    const reHide = await run(interceptor, makeRequest(hidePath), { hidden: true });
    expect(reHide.next.handle).not.toHaveBeenCalled();
    expect(reHide.result).toEqual({ hidden: true });

    // Unhide dengan key yang sama: DIEKSEKUSI, bukan replay dari hide.
    const unhide = await run(interceptor, makeRequest(unhidePath), { hidden: false });
    expect(unhide.next.handle).toHaveBeenCalledTimes(1);
    expect(unhide.result).toEqual({ hidden: false });
    expect(records.has(unhideScopeKey)).toBe(true);
  });

  it('actor berbeda dengan key yang sama mendapat scope terpisah', async () => {
    const { interceptor, records } = makeInterceptorWith(new Map());
    await run(interceptor, makeRequest(hidePath, 'user-1'), { hidden: true });
    await run(interceptor, makeRequest(hidePath, 'user-2'), { hidden: true });
    expect(records.size).toBe(2);
    expect([...records.keys()]).toEqual(
      expect.arrayContaining([
        `user-1:POST:${hidePath}:${idempotencyKey}`,
        `user-2:POST:${hidePath}:${idempotencyKey}`,
      ]),
    );
  });

  it('method berbeda dengan path+key yang sama mendapat scope terpisah', async () => {
    const { interceptor, records } = makeInterceptorWith(new Map());
    await run(interceptor, makeRequest(hidePath, 'user-1', 'POST'), { hidden: true });
    await run(interceptor, makeRequest(hidePath, 'user-1', 'DELETE'), { hidden: true });
    expect(records.size).toBe(2);
    expect([...records.keys()]).toEqual(
      expect.arrayContaining([
        `user-1:POST:${hidePath}:${idempotencyKey}`,
        `user-1:DELETE:${hidePath}:${idempotencyKey}`,
      ]),
    );
  });
});
