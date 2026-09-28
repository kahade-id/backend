import { HttpException, HttpStatus, ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function makeHost(): { host: ArgumentsHost; jsonSpy: jest.Mock; statusSpy: jest.Mock } {
  const jsonSpy = jest.fn();
  const statusSpy = jest.fn().mockReturnValue({ json: jsonSpy });
  const response: any = {
    get: jest.fn().mockReturnValue(undefined),
    setHeader: jest.fn(),
    status: statusSpy,
  };
  const host = { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }) } as unknown as ArgumentsHost;
  return { host, jsonSpy, statusSpy };
}

describe('HttpExceptionFilter — fields passthrough (batch 139 BE-API2, item 120)', () => {
  it('forwards sanitized validation fields under errors.fields', () => {
    const filter = new HttpExceptionFilter();
    const { host, jsonSpy, statusSpy } = makeHost();
    const ex = new HttpException(
      {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        fields: [{ field: 'productType', messages: ['must be one of JASA,FISIK,DIGITAL,LAINNYA'] }],
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    filter.catch(ex, host);
    expect(statusSpy).toHaveBeenCalledWith(422);
    const body = jsonSpy.mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.errors.code).toBe('VALIDATION_ERROR');
    expect(body.errors.fields).toEqual([
      { field: 'productType', messages: ['must be one of JASA,FISIK,DIGITAL,LAINNYA'] },
    ]);
  });

  it('strips non-conforming entries and injected junk (target/value)', () => {
    const filter = new HttpExceptionFilter();
    const { host, jsonSpy } = makeHost();
    const ex = new HttpException(
      {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        fields: [
          { field: 'phone', messages: ['invalid'], target: { phone: '+6281' }, value: '+6281' },
          { field: 123 as any, messages: 'not-an-array' as any },
          'junk',
        ],
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    filter.catch(ex, host);
    const body = JSON.stringify(jsonSpy.mock.calls[0][0]);
    expect(body).not.toContain('+6281');
    expect(body).not.toContain('junk');
    const parsed = JSON.parse(body);
    expect(parsed.errors.fields).toEqual([{ field: 'phone', messages: ['invalid'] }]);
  });

  it('omits errors.fields entirely for non-validation errors', () => {
    const filter = new HttpExceptionFilter();
    const { host, jsonSpy } = makeHost();
    filter.catch(new HttpException({ code: 'NOT_FOUND', message: 'gone' }, HttpStatus.NOT_FOUND), host);
    expect(jsonSpy.mock.calls[0][0].errors.fields).toBeUndefined();
  });
});
