"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let SearchService = class SearchService {
    constructor(prisma) {
        this.prisma = prisma;
        this.LIMIT = 5;
    }
    async search(userId, query, types, limit) {
        const q = this.normalizeQuery(query);
        if (!q)
            return { users: [], orders: [], transactions: [], totals: { users: 0, orders: 0, transactions: 0 } };
        const effectiveLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 50) : this.LIMIT;
        const typeSet = types?.length ? new Set(types) : new Set(['users', 'orders', 'transactions']);
        const [users, orders, transactions] = await Promise.all([
            typeSet.has('users') ? this.searchUsers(q, userId, effectiveLimit) : Promise.resolve({ results: [], total: 0 }),
            typeSet.has('orders') ? this.searchOrders(userId, q, effectiveLimit) : Promise.resolve({ results: [], total: 0 }),
            typeSet.has('transactions') ? this.searchTransactions(userId, q, effectiveLimit) : Promise.resolve({ results: [], total: 0 }),
        ]);
        return {
            users: users.results,
            orders: orders.results,
            transactions: transactions.results,
            totals: {
                users: users.total,
                orders: orders.total,
                transactions: transactions.total,
            },
        };
    }
    async suggestions(userId, query, limit) {
        const q = this.normalizeQuery(query);
        if (!q || q.length < 2)
            return { suggestions: [] };
        const tsQuery = this.buildTsQuery(q);
        if (!tsQuery)
            return { suggestions: [] };
        const effectiveLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 20) : 6;
        const halfLimit = Math.max(Math.ceil(effectiveLimit / 2), 1);
        const blockedIds = await this.getBlockedUserIds(userId);
        const blockedIdsArray = blockedIds.length > 0 ? blockedIds : ['__none__'];
        const users = await this.prisma.$queryRaw `
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
        const orders = await this.prisma.$queryRaw `
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
    async searchUsers(query, userId, limit) {
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
        let results;
        let total;
        if (tsQuery) {
            const [rows, countResult] = await Promise.all([
                this.prisma.$queryRaw `
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
                this.prisma.$queryRaw `
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
        }
        else {
            const [rows, countResult] = await Promise.all([
                this.prisma.user.findMany({
                    where: {
                        ...activeFilters,
                        OR: [
                            { username: { contains: query, mode: 'insensitive' } },
                            { fullName: { contains: query, mode: 'insensitive' } },
                        ],
                    },
                    select: { id: true, username: true, fullName: true, avatarUrl: true },
                    take,
                }),
                this.prisma.user.count({
                    where: {
                        ...activeFilters,
                        OR: [
                            { username: { contains: query, mode: 'insensitive' } },
                            { fullName: { contains: query, mode: 'insensitive' } },
                        ],
                    },
                }),
            ]);
            results = rows;
            total = countResult;
        }
        return { results, total };
    }
    async searchOrders(userId, query, limit) {
        const take = limit || this.LIMIT;
        const tsQuery = this.buildTsQuery(query);
        if (tsQuery) {
            const [rows, countResult] = await Promise.all([
                this.prisma.$queryRaw `
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
                this.prisma.$queryRaw `
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
            title: { contains: query, mode: 'insensitive' },
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
    async searchTransactions(userId, query, limit) {
        const take = limit || this.LIMIT;
        const wallet = await this.prisma.wallet.findUnique({ where: { userId }, select: { id: true } });
        if (!wallet)
            return { results: [], total: 0 };
        const where = {
            walletId: wallet.id,
            OR: [
                { description: { contains: query, mode: 'insensitive' } },
                { txId: { contains: query, mode: 'insensitive' } },
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
    async getBlockedUserIds(userId) {
        const blocks = await this.prisma.blockList.findMany({
            where: {
                OR: [{ blockerId: userId }, { blockedId: userId }],
            },
            select: { blockerId: true, blockedId: true },
            take: 1000,
        });
        const ids = new Set();
        for (const b of blocks) {
            if (b.blockerId === userId)
                ids.add(b.blockedId);
            else
                ids.add(b.blockerId);
        }
        return Array.from(ids);
    }
    normalizeQuery(query) {
        return query.normalize('NFKC').replace(/[<>&"']/g, '').trim().slice(0, 200);
    }
    buildTsQuery(query) {
        const words = query
            .replace(/[^\p{L}\p{N}_\s]/gu, '')
            .split(/\s+/u)
            .filter(w => w.length > 0);
        if (words.length === 0)
            return null;
        return words.map(w => `${w}:*`).join(' & ');
    }
};
exports.SearchService = SearchService;
exports.SearchService = SearchService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], SearchService);
