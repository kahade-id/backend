import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { PaginationDto, createPaginatedResponse } from './pagination.dto';

describe('PaginationDto', () => {
  async function validateDto(data: Record<string, unknown>) {
    const instance = plainToInstance(PaginationDto, data);
    return validate(instance);
  }

  it('accepts valid page and limit', async () => {
    const errors = await validateDto({ page: 1, limit: 20 });
    expect(errors).toHaveLength(0);
  });

  it('uses defaults when page and limit are absent', () => {
    const instance = plainToInstance(PaginationDto, {});
    expect(instance.page).toBe(1);
    expect(instance.limit).toBe(20);
  });

  it('rejects page = 0', async () => {
    const errors = await validateDto({ page: 0, limit: 20 });
    expect(errors.some(e => e.property === 'page')).toBe(true);
  });

  it('rejects negative page', async () => {
    const errors = await validateDto({ page: -1, limit: 20 });
    expect(errors.some(e => e.property === 'page')).toBe(true);
  });

  it('rejects limit = 0', async () => {
    const errors = await validateDto({ page: 1, limit: 0 });
    expect(errors.some(e => e.property === 'limit')).toBe(true);
  });

  it('rejects limit > 100', async () => {
    const errors = await validateDto({ page: 1, limit: 101 });
    expect(errors.some(e => e.property === 'limit')).toBe(true);
  });

  it('accepts limit = 100 (maximum)', async () => {
    const errors = await validateDto({ page: 1, limit: 100 });
    expect(errors).toHaveLength(0);
  });

  it('accepts limit = 1 (minimum)', async () => {
    const errors = await validateDto({ page: 1, limit: 1 });
    expect(errors).toHaveLength(0);
  });

  it('rejects non-integer page', async () => {
    const errors = await validateDto({ page: 1.5, limit: 10 });
    expect(errors.some(e => e.property === 'page')).toBe(true);
  });

  it('coerces string numbers via @Type', () => {
    const instance = plainToInstance(PaginationDto, { page: '2', limit: '50' });
    expect(instance.page).toBe(2);
    expect(instance.limit).toBe(50);
  });
});

describe('createPaginatedResponse', () => {
  const data = ['a', 'b', 'c'];

  it('returns a correctly shaped paginated response', () => {
    const result = createPaginatedResponse(data, 30, 2, 10);
    expect(result).toEqual({
      data: ['a', 'b', 'c'],
      total: 30,
      page: 2,
      limit: 10,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
  });

  it('calculates totalPages correctly for partial last page', () => {
    const result = createPaginatedResponse([], 21, 1, 10);
    expect(result.totalPages).toBe(3);
  });

  it('calculates totalPages = 1 when total <= limit', () => {
    const result = createPaginatedResponse(data, 3, 1, 10);
    expect(result.totalPages).toBe(1);
  });

  it('calculates totalPages = 0 when total is 0', () => {
    const result = createPaginatedResponse([], 0, 1, 20);
    expect(result.totalPages).toBe(0);
  });

  it('passes through page and limit values unmodified', () => {
    const result = createPaginatedResponse([], 100, 5, 20);
    expect(result.page).toBe(5);
    expect(result.limit).toBe(20);
  });
});
