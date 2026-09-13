/**
 * Shared database pool configuration.
 *
 * Previously the pool parameters existed twice with DIFFERENT env var names and
 * defaults: `database.config.ts` read DB_POOL_SIZE (default 20) and computed a
 * URL that nothing consumed, while `PrismaService` silently read
 * DATABASE_CONNECTION_LIMIT (default 10). Operators setting the documented
 * DB_POOL_SIZE got no effect. Both now share this single implementation.
 *
 * Behaviour (unchanged for URLs that already carry params): any param already
 * present in DATABASE_URL wins over the env var.
 */
export const DB_POOL_SIZE_ENV = 'DB_POOL_SIZE';

export function defaultDbPoolSize(): number {
  const isProduction = process.env.NODE_ENV === 'production';
  return parseInt(process.env[DB_POOL_SIZE_ENV] || (isProduction ? '20' : '5'), 10);
}

/**
 * Append Prisma connection-pool params to a raw DATABASE_URL unless the URL
 * already specifies them. Falls back to naive concatenation for URLs that the
 * URL constructor rejects (e.g. Unix-socket style DSNs).
 */
export function applyDbPoolParams(rawUrl: string): string {
  const connectionLimit = defaultDbPoolSize();
  const poolTimeout = process.env.DB_POOL_TIMEOUT || '10';
  const connectTimeout = process.env.DB_CONNECT_TIMEOUT || '15';
  const statementTimeout = process.env.DB_STATEMENT_TIMEOUT || '30000';

  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', String(connectionLimit));
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', poolTimeout);
    }
    if (!url.searchParams.has('connect_timeout')) {
      url.searchParams.set('connect_timeout', connectTimeout);
    }
    if (!url.searchParams.has('statement_timeout')) {
      url.searchParams.set('statement_timeout', statementTimeout);
    }
    return url.toString();
  } catch {
    const sep = rawUrl.includes('?') ? '&' : '?';
    return `${rawUrl}${sep}connection_limit=${connectionLimit}&pool_timeout=${poolTimeout}&connect_timeout=${connectTimeout}&statement_timeout=${statementTimeout}`;
  }
}
