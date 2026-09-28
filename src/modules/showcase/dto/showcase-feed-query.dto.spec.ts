/**
 * Batch 139 BE-API2 (item 121): query `productType` pada feed showcase —
 * case-insensitive (dinormalisasi ke uppercase), enum JASA/FISIK/DIGITAL/LAINNYA.
 */
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ShowcaseFeedQueryDto } from './showcase-feed-query.dto';

describe('ShowcaseFeedQueryDto — productType (batch 139 BE-API2, item 121)', () => {
  const toDto = (q: object): ShowcaseFeedQueryDto => plainToInstance(ShowcaseFeedQueryDto, q);

  it('accepts a lowercase productType and normalizes it to uppercase', async () => {
    const dto = toDto({ productType: 'fisik' });
    expect(dto.productType).toBe('FISIK');
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts every ProductType enum value', async () => {
    for (const v of ['JASA', 'FISIK', 'DIGITAL', 'LAINNYA']) {
      const dto = toDto({ productType: v });
      expect(await validate(dto)).toHaveLength(0);
    }
  });

  it('rejects a non-enum productType', async () => {
    const errors = await validate(toDto({ productType: 'BARANG' }));
    expect(errors.some((e) => e.property === 'productType')).toBe(true);
  });

  it('leaves productType undefined when absent (no filtering)', async () => {
    const dto = toDto({});
    expect(dto.productType).toBeUndefined();
    expect(await validate(dto)).toHaveLength(0);
  });
});
