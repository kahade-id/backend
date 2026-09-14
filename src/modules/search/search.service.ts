import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { escapeLikePattern } from '../../common/utils/search.util';

@Injectable()
export class SearchService {
  private readonly LIMIT = 5;

  constructor(private prisma: PrismaService, private redis: RedisService) {}

  async search(userId: string, query: string, types?: string[], limit?: number): Promise<object> {
    const q = this.normalizeQuery(query);
    if (!q) return { users: [], orders: [], transactions: [], showcase: [], helpCenter: [], totals: { users: 0, orders: 0, transactions: 0, showcase: 0, helpCenter: 0 } };

    const effectiveLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit as number, 1), 50) : this.LIMIT;
    const typeSet = types?.length ? new Set(types) : new Set(['users', 'orders', 'transactions', 'showcase', 'help-center']);

    const [users, orders, transactions, showcase, helpCenter] = await Promise.all([
      typeSet.has('users') ? this.searchUsers(q, userId, effectiveLimit) : Promise.resolve({ results: [], total: 0 }),
      typeSet.has('orders') ? this.searchOrders(userId, q, effectiveLimit) : Promise.resolve({ results: [], total: 0 }),
      typeSet.has('transactions') ? this.searchTransactions(userId, q, effectiveLimit) : Promise.resolve({ results: [], total: 0 }),
      typeSet.has('showcase') ? this.searchShowcase(q, effectiveLimit) : Promise.resolve({ results: [], total: 0 }),
      typeSet.has('help-center') ? this.searchHelpCenter(q, effectiveLimit) : Promise.resolve({ results: [], total: 0 }),
    ]);

    // Save search history async (best effort)
    if (q.length >= 2) {
      this.saveSearchHistory(userId, q).catch(() => {});
    }

    return {
      users: users.results,
      orders: orders.results,
      transactions: transactions.results,
      showcase: showcase.results,
      helpCenter: helpCenter.results,
      totals: {
        users: users.total,
        orders: orders.total,
        transactions: transactions.total,
        showcase: showcase.total,
        helpCenter: helpCenter.total,
      },
      // 13.1 hint: if main results empty, suggest trying help-center
      ...(users.total === 0 && orders.total === 0 && transactions.total === 0 && showcase.total === 0 && helpCenter.total > 0
        ? { hint: 'No results in users/orders/transactions/showcase, but found help articles — try help-center' }
        : {}),
      ...(users.total === 0 && orders.total === 0 && transactions.total === 0 && showcase.total === 0 && helpCenter.total === 0
        ? { hint: 'No results found — try searching in Help Center or check your spelling' }
        : {}),
    };
  }

  private async saveSearchHistory(userId: string, query: string): Promise<void> {
    const key = `search_history:${userId}`;
    try {
      const client = this.redis.getClient();
      await client.lrem(key, 0, query);
      await client.lpush(key, query);
      await client.ltrim(key, 0, 19);
      await client.expire(key, 60 * 60 * 24 * 30);
    } catch {}
  }

  async getSearchHistory(userId: string): Promise<{ history: string[] }> {
    const key = `search_history:${userId}`;
    try {
      const client = this.redis.getClient();
      const history = await client.lrange(key, 0, 19);
      return { history };
    } catch {
      return { history: [] };
    }
  }

  async clearSearchHistory(userId: string): Promise<{ cleared: boolean }> {
    const key = `search_history:${userId}`;
    try {
      await this.redis.del(key);
    } catch {}
    return { cleared: true };
  }

  async suggestions(userId: string, query: string, limit?: number): Promise<object> {
    const q = this.normalizeQuery(query);
    if (!q || q.length < 2) return { suggestions: [] };

    const tsQuery = this.buildTsQuery(q);
    if (!tsQuery) return { suggestions: [] };

    const effectiveLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit as number, 1), 20) : 6;
    const halfLimit = Math.max(Math.ceil(effectiveLimit / 2), 1);

    const blockedIds = await this.getBlockedUserIds(userId);
    const blockedIdsArray = blockedIds.length > 0 ? blockedIds : ['__none__'];

    const users = await this.prisma.$queryRaw<{ label: string; type: string }[]>`
      SELECT "fullName" AS label, 'user' AS type
      FROM users
      WHERE to_tsvector('simple', COALESCE("fullName",'') || ' ' || COALESCE("username",''))
            @@ to_tsquery('simple', ${tsQuery})
        AND "isActive" = true
        AND "isBanned" = false
        AND "deletedAt" IS NULL
        AND "profileVisible" = true
        AND id NOT IN (SELECT unnest(${blockedIdsArray}::text[]))
      ORDER BY ts_rank(
        to_tsvector('simple', COALESCE("fullName",'') || ' ' || COALESCE("username",'')),
        to_tsquery('simple', ${tsQuery})
      ) DESC, "fullName" ASC, id ASC
      LIMIT ${halfLimit}
    `.catch(() => []);

    const orders = await this.prisma.$queryRaw<{ label: string; type: string }[]>`
      SELECT title AS label, 'order' AS type
      FROM orders
      WHERE ("buyerId" = ${userId} OR "sellerId" = ${userId})
        AND "deletedAt" IS NULL
        AND to_tsvector('simple', COALESCE(title,''))
            @@ to_tsquery('simple', ${tsQuery})
      ORDER BY "createdAt" DESC, id ASC
      LIMIT ${halfLimit}
    `.catch(() => []);

    return { suggestions: [...users, ...orders].slice(0, effectiveLimit) };
  }

  private async searchUsers(query: string, userId?: string, limit?: number): Promise<{ results: object[]; total: number }> {
    const take = limit || this.LIMIT;
    const tsQuery = this.buildTsQuery(query);
    const blockedIds = userId ? await this.getBlockedUserIds(userId) : [];
    const blockedIdsArray = blockedIds.length > 0 ? blockedIds : ['__none__'];

    const activeFilters = {
      isActive: true,
      isBanned: false,
      deletedAt: null,
      profileVisible: true,
      ...(blockedIds.length > 0 ? { id: { notIn: blockedIds } } : {}),
    };

    let results: object[];
    let total: number;

    if (tsQuery) {
      const [rows, countResult] = await Promise.all([
        this.prisma.$queryRaw<{ id: string; username: string | null; fullName: string; avatarUrl: string | null; rank: number }[]>`
          SELECT
            id, username, "fullName", "avatarUrl",
            ts_rank(
              to_tsvector('simple', COALESCE("fullName",'') || ' ' || COALESCE("username",'')),
              to_tsquery('simple', ${tsQuery})
            ) AS rank
          FROM users
          WHERE to_tsvector('simple', COALESCE("fullName",'') || ' ' || COALESCE("username",''))
                @@ to_tsquery('simple', ${tsQuery})
            AND "isActive" = true
            AND "isBanned" = false
            AND "deletedAt" IS NULL
            AND "profileVisible" = true
            AND id NOT IN (SELECT unnest(${blockedIdsArray}::text[]))
          ORDER BY rank DESC
          LIMIT ${take}
        `.catch(() => []),
        this.prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count FROM users
          WHERE to_tsvector('simple', COALESCE("fullName",'') || ' ' || COALESCE("username",''))
                @@ to_tsquery('simple', ${tsQuery})
            AND "isActive" = true
            AND "isBanned" = false
            AND "deletedAt" IS NULL
            AND "profileVisible" = true
            AND id NOT IN (SELECT unnest(${blockedIdsArray}::text[]))
        `.catch(() => [{ count: BigInt(0) }]),
      ]);
      results = rows;
      total = Number(countResult[0]?.count ?? 0);
    } else {
      const [rows, countResult] = await Promise.all([
        this.prisma.user.findMany({
          where: {
            ...activeFilters,
            OR: [
              { username: { contains: escapeLikePattern(query), mode: 'insensitive' } },
              { fullName: { contains: escapeLikePattern(query), mode: 'insensitive' } },
            ],
          },
          select: { id: true, username: true, fullName: true, avatarUrl: true },
          take,
        }),
        this.prisma.user.count({
          where: {
            ...activeFilters,
            OR: [
              { username: { contains: escapeLikePattern(query), mode: 'insensitive' } },
              { fullName: { contains: escapeLikePattern(query), mode: 'insensitive' } },
            ],
          },
        }),
      ]);
      results = rows;
      total = countResult;
    }

    return { results, total };
  }

  private async searchOrders(userId: string, query: string, limit?: number): Promise<{ results: object[]; total: number }> {
    const take = limit || this.LIMIT;
    const tsQuery = this.buildTsQuery(query);

    if (tsQuery) {
      const [rows, countResult] = await Promise.all([
        this.prisma.$queryRaw<object[]>`
          SELECT
            id, title, status, "orderValue", "createdAt",
            ts_rank(
              to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,'')),
              to_tsquery('simple', ${tsQuery})
            ) AS rank
          FROM orders
          WHERE ("buyerId" = ${userId} OR "sellerId" = ${userId})
            AND "deletedAt" IS NULL
            AND to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,''))
                @@ to_tsquery('simple', ${tsQuery})
          ORDER BY rank DESC, "createdAt" DESC
          LIMIT ${take}
        `.catch(() => []),
        this.prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) AS count FROM orders
          WHERE ("buyerId" = ${userId} OR "sellerId" = ${userId})
            AND "deletedAt" IS NULL
            AND to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,''))
                @@ to_tsquery('simple', ${tsQuery})
        `.catch(() => [{ count: BigInt(0) }]),
      ]);
      return { results: rows, total: Number(countResult[0]?.count ?? 0) };
    }

    const where = {
      AND: [{ OR: [{ buyerId: userId }, { sellerId: userId }] }, { deletedAt: null }],
      title: { contains: escapeLikePattern(query), mode: 'insensitive' as const },
    };

    const [rows, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        select: { id: true, title: true, status: true, orderValue: true, createdAt: true },
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { results: rows, total };
  }

  private async searchTransactions(userId: string, query: string, limit?: number): Promise<{ results: object[]; total: number }> {
    const take = limit || this.LIMIT;
    const wallet = await this.prisma.wallet.findUnique({ where: { userId }, select: { id: true } });
    if (!wallet) return { results: [], total: 0 };

    const where = {
      walletId: wallet.id,
      OR: [
        { description: { contains: escapeLikePattern(query), mode: 'insensitive' as const } },
        { txId: { contains: escapeLikePattern(query), mode: 'insensitive' as const } },
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        select: { id: true, txId: true, type: true, amount: true, description: true, createdAt: true },
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    return { results: rows, total };
  }

  private async searchShowcase(query: string, limit?: number): Promise<{ results: object[]; total: number }> {
    const take = limit || this.LIMIT;
    const tsQuery = this.buildTsQuery(query);
    if (tsQuery) {
      try {
        const rows = await this.prisma.$queryRaw<object[]>`
          SELECT id, title, description, "userId", "createdAt",
                 ts_rank(to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,'')), to_tsquery('simple', ${tsQuery})) AS rank
          FROM user_showcases
          WHERE "deletedAt" IS NULL AND "isPublic" = true
            AND to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,'')) @@ to_tsquery('simple', ${tsQuery})
          ORDER BY rank DESC, "createdAt" DESC
          LIMIT ${take}
        `;
        const countResult = await this.prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) as count FROM user_showcases
          WHERE "deletedAt" IS NULL AND "isPublic" = true
            AND to_tsvector('simple', COALESCE(title,'') || ' ' || COALESCE(description,'')) @@ to_tsquery('simple', ${tsQuery})
        `.catch(() => [{ count: BigInt(0) }]);
        return { results: rows as object[], total: Number(countResult[0]?.count ?? 0) };
      } catch {}
    }
    try {
      const where = {
        deletedAt: null,
        isPublic: true,
        OR: [
          { title: { contains: escapeLikePattern(query), mode: 'insensitive' as const } },
          { description: { contains: escapeLikePattern(query), mode: 'insensitive' as const } },
        ],
      } as any;
      const [rows, total] = await Promise.all([
        this.prisma.userShowcase.findMany({ where, select: { id: true, title: true, description: true, userId: true, createdAt: true }, take, orderBy: { createdAt: 'desc' } }),
        this.prisma.userShowcase.count({ where }),
      ]);
      return { results: rows, total };
    } catch {
      return { results: [], total: 0 };
    }
  }

  private async searchHelpCenter(query: string, limit?: number): Promise<{ results: object[]; total: number }> {
    const take = limit || this.LIMIT;
    const tsQuery = this.buildTsQuery(query);
    if (tsQuery) {
      try {
        const rows = await this.prisma.$queryRaw<object[]>`
          SELECT id, question, answer, "categoryId", "createdAt",
                 ts_rank(to_tsvector('simple', COALESCE(question,'') || ' ' || COALESCE(answer,'')), to_tsquery('simple', ${tsQuery})) AS rank
          FROM faq_items
          WHERE "isActive" = true
            AND to_tsvector('simple', COALESCE(question,'') || ' ' || COALESCE(answer,'')) @@ to_tsquery('simple', ${tsQuery})
          ORDER BY rank DESC, "createdAt" DESC
          LIMIT ${take}
        `;
        const countResult = await this.prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(*) as count FROM faq_items
          WHERE "isActive" = true
            AND to_tsvector('simple', COALESCE(question,'') || ' ' || COALESCE(answer,'')) @@ to_tsquery('simple', ${tsQuery})
        `.catch(() => [{ count: BigInt(0) }]);
        return { results: rows as object[], total: Number(countResult[0]?.count ?? 0) };
      } catch {}
    }
    try {
      const where = {
        isActive: true,
        OR: [
          { question: { contains: escapeLikePattern(query), mode: 'insensitive' as const } },
          { answer: { contains: escapeLikePattern(query), mode: 'insensitive' as const } },
        ],
      } as any;
      const [rows, total] = await Promise.all([
        this.prisma.faqItem.findMany({ where, select: { id: true, question: true, categoryId: true, createdAt: true }, take, orderBy: { createdAt: 'desc' } }),
        this.prisma.faqItem.count({ where }),
      ]);
      return { results: rows, total };
    } catch {
      return { results: [], total: 0 };
    }
  }

  private async getBlockedUserIds(userId: string): Promise<string[]> {
    // Unbounded before: every id is interpolated into the `unnest(...::text[])`
    // parameter of the search queries below, so a user with a large block list
    // produced an ever-growing query payload on every keystroke of /search and
    // /search/suggestions. Cap it — the block list is a relevance filter, not a
    // security boundary (profileVisible/isActive/isBanned do that work).
    const blocks = await this.prisma.blockList.findMany({
      where: {
        OR: [{ blockerId: userId }, { blockedId: userId }],
      },
      select: { blockerId: true, blockedId: true },
      take: 1000,
    });
    const ids = new Set<string>();
    for (const b of blocks) {
      if (b.blockerId === userId) ids.add(b.blockedId);
      else ids.add(b.blockerId);
    }
    return Array.from(ids);
  }

  private normalizeQuery(query: string): string {
    return query.normalize('NFKC').replace(/[<>&"']/g, '').trim().slice(0, 200);
  }

  private buildTsQuery(query: string): string | null {
    const words = query
      .replace(/[^\p{L}\p{N}_\s]/gu, '')
      .split(/\s+/u)
      .filter(w => w.length > 0);

    if (words.length === 0) return null;

    return words.map(w => `${w}:*`).join(' & ');
  }
}
