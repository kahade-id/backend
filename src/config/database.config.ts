import { registerAs } from '@nestjs/config';
import { applyDbPoolParams, defaultDbPoolSize } from './db-url.util';

/**
 * Database/pool configuration.
 *
 * The effective pool URL applied to the Prisma client is built by
 * `src/config/db-url.util.ts` (shared with PrismaService, single source of
 * truth). This factory exposes the resolved values for diagnostics and keeps
 * the documented defaults in one place:
 *   connection_limit — DB_POOL_SIZE (default 20 prod / 5 dev)
 *   pool_timeout     — DB_POOL_TIMEOUT (default 10s)
 *   connect_timeout  — DB_CONNECT_TIMEOUT (default 15s)
 *   statement_timeout — DB_STATEMENT_TIMEOUT (default 30000ms)
 *
 * Any of these can also be set directly in DATABASE_URL query params, which
 * always take precedence over the env vars.
 */
export const databaseConfig = registerAs('database', () => {
  const baseUrl = process.env.DATABASE_URL || '';

  if (!baseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return {
    url: applyDbPoolParams(baseUrl),
    poolSize: defaultDbPoolSize(),
    poolTimeout: parseInt(process.env.DB_POOL_TIMEOUT || '10', 10),
    connectTimeout: parseInt(process.env.DB_CONNECT_TIMEOUT || '15', 10),
    statementTimeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10),
  };
});
