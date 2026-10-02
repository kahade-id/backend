import { formatIdr, formatSen, toSen, toIdr } from './currency.util';

/**
 * SYS-C-101/SYS-C-104 (audit sistemik ronde 3, 2026-10-03): kebijakan
 * format kanonis — pecahan tampil 2 desimal (BAI-052, BUKAN Math.round),
 * bilangan bulat tanpa desimal, negatif kanonis "-RpX", tanpa spasi.
 */
describe('formatIdr', () => {
  it('bilangan bulat: tanpa desimal, tanpa spasi', () => {
    expect(formatIdr(100000)).toBe('Rp100.000');
    expect(formatIdr(0)).toBe('Rp0');
    expect(formatIdr(1000000000)).toBe('Rp1.000.000.000');
  });

  it('pecahan: 2 desimal (BAI-052), bukan Math.round', () => {
    expect(formatIdr(100000.5)).toBe('Rp100.000,50');
    expect(formatIdr(10.25)).toBe('Rp10,25');
  });

  it('negatif kanonis "-RpX"', () => {
    expect(formatIdr(-50000)).toBe('-Rp50.000');
    expect(formatIdr(-10.5)).toBe('-Rp10,50');
  });

  it('input non-finite melempar', () => {
    expect(() => formatIdr(NaN)).toThrow(RangeError);
    expect(() => formatIdr(Infinity)).toThrow(RangeError);
  });
});

describe('formatSen', () => {
  it('sen kelipatan 100: tanpa desimal', () => {
    expect(formatSen(10000000n)).toBe('Rp100.000');
    expect(formatSen(0n)).toBe('Rp0');
  });

  it('pecahan sen: 2 desimal eksak (string-based, tanpa float)', () => {
    expect(formatSen(1050n)).toBe('Rp10,50');
    expect(formatSen(10000050n)).toBe('Rp100.000,50');
    expect(formatSen(1n)).toBe('Rp0,01');
  });

  it('negatif kanonis "-RpX"', () => {
    expect(formatSen(-5000n)).toBe('-Rp50');
    expect(formatSen(-1050n)).toBe('-Rp10,50');
  });

  it('round-trip toSen/formatSen', () => {
    expect(formatSen(toSen(1500))).toBe('Rp1.500');
    expect(toIdr(1050n)).toBe(10.5);
  });
});
