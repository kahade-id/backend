import { of } from 'rxjs';
import { RequestIdInterceptor } from '../request-id.interceptor';
import { requestContext } from '../../../prisma/prisma.service';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeContext(headerValue: unknown): { ctx: any; req: any; res: any } {
  const req: any = { headers: { 'x-request-id': headerValue } };
  const headers: Record<string, string> = {};
  const res: any = { setHeader: (k: string, v: string) => { headers[k] = v; }, _headers: headers };
  const ctx: any = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  };
  return { ctx, req, res };
}

describe('RequestIdInterceptor', () => {
  const interceptor = new RequestIdInterceptor();

  it('accepts valid inbound UUID v4 and echoes in X-Request-ID response header', (done) => {
    const valid = '550e8400-e29b-41d4-a716-446655440000';
    const { ctx, req, res } = makeContext(valid);
    const next = { handle: () => of('payload') };

    interceptor.intercept(ctx, next as any).subscribe({
      next: () => {
        expect(req.requestId).toBe(valid);
        expect(res._headers['X-Request-ID']).toBe(valid);
      },
      complete: () => done(),
    });
  });

  it('REPLACES invalid inbound x-request-id with a fresh UUID v4', (done) => {
    const { ctx, req, res } = makeContext('not-a-uuid; DROP TABLE users;--');
    const next = { handle: () => of(null) };

    interceptor.intercept(ctx, next as any).subscribe({
      next: () => {
        expect(req.requestId).not.toBe('not-a-uuid; DROP TABLE users;--');
        expect(req.requestId).toMatch(UUID_V4);
        expect(res._headers['X-Request-ID']).toBe(req.requestId);
      },
      complete: () => done(),
    });
  });

  it('GENERATES a UUID v4 when no header is present', (done) => {
    const { ctx, req, res } = makeContext(undefined);
    const next = { handle: () => of(null) };

    interceptor.intercept(ctx, next as any).subscribe({
      next: () => {
        expect(req.requestId).toMatch(UUID_V4);
        expect(res._headers['X-Request-ID']).toMatch(UUID_V4);
      },
      complete: () => done(),
    });
  });

  it('exposes requestId via AsyncLocalStorage during downstream handler', (done) => {
    const valid = '550e8400-e29b-41d4-a716-446655440001';
    const { ctx } = makeContext(valid);
    let observedFromContext: string | undefined;
    const next = {
      handle: () => {
        observedFromContext = requestContext.getStore()?.requestId;
        return of('ok');
      },
    };

    interceptor.intercept(ctx, next as any).subscribe({
      complete: () => {
        expect(observedFromContext).toBe(valid);
        done();
      },
    });
  });
});
