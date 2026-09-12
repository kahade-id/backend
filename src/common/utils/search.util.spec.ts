import { escapeLikePattern } from './search.util';

/**
 * R2-M (audit): PostgreSQL LIKE treats %, _ and \ as pattern metacharacters.
 * Unescaped free-text search meant `100%` matched every row and `_` matched any
 * character — inconsistent results on every endpoint that forgot to escape.
 */
describe('escapeLikePattern', () => {
  it('escapes LIKE wildcards', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves ordinary characters untouched', () => {
    expect(escapeLikePattern('plain search')).toBe('plain search');
    expect(escapeLikePattern('')).toBe('');
  });
});
