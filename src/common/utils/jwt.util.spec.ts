import { parseJwtTtl } from './jwt.util';

/**
 * R2-I (audit): @nestjs/jwt hands `expiresIn` to the `ms` package, which accepts
 * spaced and spelled-out forms ("2 days", "90 mins", "1w"). The old parser only
 * understood compact `(\d+)(s|m|h|d|w)` strings and silently fell back to 900s —
 * meaning revocation markers would expire long before the tokens they gate.
 */
describe('parseJwtTtl', () => {
  it('parses compact forms', () => {
    expect(parseJwtTtl('30s')).toBe(30);
    expect(parseJwtTtl('15m')).toBe(900);
    expect(parseJwtTtl('2h')).toBe(7200);
    expect(parseJwtTtl('1d')).toBe(86400);
    expect(parseJwtTtl('2w')).toBe(1209600);
  });

  it('parses the spaced/word forms the token library itself accepts', () => {
    expect(parseJwtTtl('2 days')).toBe(172800);
    expect(parseJwtTtl('90 mins')).toBe(5400);
    expect(parseJwtTtl('1 week')).toBe(604800);
    expect(parseJwtTtl('6 hours')).toBe(21600);
    expect(parseJwtTtl('45 MINUTES')).toBe(2700);
  });

  it('falls back to the 15m default for unparsable values', () => {
    expect(parseJwtTtl('soon')).toBe(900);
    expect(parseJwtTtl('15')).toBe(900);
    expect(parseJwtTtl('')).toBe(900);
    expect(parseJwtTtl(undefined as unknown as string)).toBe(900);
  });

  it('clamps absurd lifetimes to 30 days', () => {
    expect(parseJwtTtl('400d')).toBe(30 * 24 * 3600);
  });
});
