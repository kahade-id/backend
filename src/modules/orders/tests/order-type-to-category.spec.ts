import { OrderType, OrderCategory } from '@prisma/client';
import { orderTypeToCategory } from '../orders.service';

describe('orderTypeToCategory (TX-UNIFIED-V2 P1-3)', () => {
  it('PHYSICAL_GOODS -> FISIK', () => {
    expect(orderTypeToCategory(OrderType.PHYSICAL_GOODS)).toBe(OrderCategory.FISIK);
  });

  it('DIGITAL_GOODS -> DIGITAL', () => {
    expect(orderTypeToCategory(OrderType.DIGITAL_GOODS)).toBe(OrderCategory.DIGITAL);
  });

  it('SERVICE -> JASA', () => {
    expect(orderTypeToCategory(OrderType.SERVICE)).toBe(OrderCategory.JASA);
  });

  it('OTHER -> FISIK (tidak ada kategori LAINNYA)', () => {
    expect(orderTypeToCategory(OrderType.OTHER)).toBe(OrderCategory.FISIK);
  });
});
