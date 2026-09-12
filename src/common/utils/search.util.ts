/**
 * R2-M (audit): PostgreSQL `LIKE` (which Prisma compiles `contains` into) treats
 * `%`, `_` and `\` as pattern metacharacters. Several search endpoints already
 * escaped them (orders, admin-orders); the rest silently treated user input as
 * wildcards — e.g. searching for `100%` matched every row, and `_` matched any
 * single character, returning unrelated users/orders/tickets. This is the single
 * shared escape helper; every `contains` fed by free-text input must use it.
 */
export function escapeLikePattern(pattern: string): string {
  return pattern.replace(/[%_\\]/g, '\\$&');
}
