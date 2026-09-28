import { HttpStatus, ValidationError } from '@nestjs/common';
import { validationExceptionFactory } from './validation-exception.factory';

function makeError(overrides: Partial<ValidationError> = {}): ValidationError {
  // ValidationError dari @nestjs/common hanya type — pakai object literal.
  const base: ValidationError = {
    property: 'username',
    constraints: { isNotEmpty: 'username should not be empty' },
  } as ValidationError;
  return Object.assign(base, overrides);
}

describe('validationExceptionFactory (batch 139 BE-API2, item 120)', () => {
  it('throws 422 with VALIDATION_ERROR code', () => {
    const ex = validationExceptionFactory([makeError()]);
    expect(ex.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(ex.getResponse()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('attributes each failing field with its constraint messages', () => {
    const ex = validationExceptionFactory([
      makeError({ property: 'productType', constraints: { isEnum: 'productType must be one of JASA,FISIK,DIGITAL,LAINNYA' } }),
      makeError({ property: 'phone', constraints: { isPhone: 'phone must be valid', isNotEmpty: 'phone required' } }),
    ]);
    const res = ex.getResponse() as any;
    expect(res.fields).toEqual([
      { field: 'productType', messages: ['productType must be one of JASA,FISIK,DIGITAL,LAINNYA'] },
      { field: 'phone', messages: ['phone must be valid', 'phone required'] },
    ]);
  });

  it('never leaks target or value (submitted data)', () => {
    const err = makeError({ target: { password: 'secret123' } as any, value: 'secret123' });
    const ex = validationExceptionFactory([err]);
    const body = JSON.stringify(ex.getResponse());
    expect(body).not.toContain('secret123');
    expect(body).not.toContain('password');
  });

  it('builds dot-paths for nested validation errors', () => {
    const child = makeError({ property: 'name', constraints: { minLength: 'too short' } });
    const parent = makeError({ property: 'items', constraints: undefined });
    parent.children = [child];
    const ex = validationExceptionFactory([parent]);
    const res = ex.getResponse() as any;
    expect(res.fields).toEqual([
      { field: 'items', messages: [], children: [{ field: 'items.name', messages: ['too short'] }] },
    ]);
  });

  it('caps fields and messages so one bad request cannot produce a giant response', () => {
    const errors = Array.from({ length: 100 }, (_, i) =>
      makeError({ property: `f${i}`, constraints: { c: 'm' } }),
    );
    const ex = validationExceptionFactory(errors);
    const res = ex.getResponse() as any;
    expect(res.fields.length).toBeLessThanOrEqual(50);
  });
});
