/**
 * SYS-A-022 (audit sistemik ronde 3) — contract test query keys kanonis.
 *
 * Backend tetap ketat (forbidNonWhitelisted): hanya key kanonis yang diterima.
 * - Katalog: `search` (bukan `q`), `inStock` (bukan `inStockOnly`)
 * - Sort order: `asc`/`desc` lowercase (bukan `ASC`/`DESC`)
 *
 * FE menyelaraskan ke kontrak ini (frontend/lib/api/*).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CatalogQueryDto } from '../dto/inventory.dto';
import { GetOrdersQueryDto } from '../../orders/dto/get-orders-query.dto';

describe('SYS-A-022 canonical query keys', () => {
  it('CatalogQueryDto menerima search + inStock', () => {
    const dto = plainToInstance(CatalogQueryDto, { search: 'kopi', inStock: 'true' });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.search).toBe('kopi');
    expect(dto.inStock).toBe('true');
  });

  it('CatalogQueryDto menolak inStock bernilai selain true/false', () => {
    const dto = plainToInstance(CatalogQueryDto, { inStock: 'yes' });
    expect(validateSync(dto).length).toBeGreaterThan(0);
  });

  it('GetOrdersQueryDto menerima asc/desc lowercase', () => {
    for (const dir of ['asc', 'desc']) {
      const dto = plainToInstance(GetOrdersQueryDto, { sortOrder: dir });
      const errors = validateSync(dto).filter((e) => e.property === 'sortOrder');
      expect(errors).toHaveLength(0);
    }
  });

  it('GetOrdersQueryDto menolak ASC/DESC uppercase', () => {
    const dto = plainToInstance(GetOrdersQueryDto, { sortOrder: 'ASC' });
    const errors = validateSync(dto).filter((e) => e.property === 'sortOrder');
    expect(errors.length).toBeGreaterThan(0);
  });
});
