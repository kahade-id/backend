import { registerAs } from '@nestjs/config';

/**
 * Prisma default is 10 connections which may be insufficient for production VPS traffic.
 *
 * Recommended settings for VPS (4 CPU, 8GB RAM):
 *   connection_limit=20   — max simultaneous DB connections
 *   pool_timeout=10       — seconds to wait for an available connection before error
 *   connect_timeout=15    — seconds to wait for initial TCP connection
 *
 * Set these via DATABASE_URL query params OR via env vars used here.
 * Example DATABASE_URL:
 *   postgresql://user:pass@host:5432/kahade_db?connection_limit=20&pool_timeout=10
 *
 * Note: If connection_limit is already in DATABASE_URL, the env vars below are ignored.
 */
export const databaseConfig = registerAs('database', () => {
  const baseUrl = process.env.DATABASE_URL || '';

  if (!baseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  // Only append pool params if they're not already in the URL
  const url = new URL(baseUrl);
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', process.env.DB_POOL_SIZE || '20');
  }
  if (!url.searchParams.has('pool_timeout')) {
    url.searchParams.set('pool_timeout', process.env.DB_POOL_TIMEOUT || '10');
  }
  if (!url.searchParams.has('connect_timeout')) {
    url.searchParams.set('connect_timeout', process.env.DB_CONNECT_TIMEOUT || '15');
  }
  if (!url.searchParams.has('statement_timeout')) {
    url.searchParams.set('statement_timeout', process.env.DB_STATEMENT_TIMEOUT || '30000');
  }

  return {
    url: url.toString(),
    poolSize: parseInt(process.env.DB_POOL_SIZE || '20', 10),
    poolTimeout: parseInt(process.env.DB_POOL_TIMEOUT || '10', 10),
    statementTimeout: parseInt(process.env.DB_STATEMENT_TIMEOUT || '30000', 10),
  };
});
