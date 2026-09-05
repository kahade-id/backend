export declare function getCached<T>(redis: {
    get: (key: string) => Promise<string | null>;
    setex: (key: string, ttl: number, value: string) => Promise<unknown>;
}, key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T>;
export declare function invalidateCache(redis: {
    del: (key: string) => Promise<unknown>;
}, key: string): Promise<void>;
export declare const CacheTTL: {
    readonly PUBLIC_PROFILE: 300;
    readonly ORDER_DETAIL: 30;
    readonly USER_STATS: 120;
    readonly WALLET_BALANCE: 10;
    readonly VOUCHER_LIST: 600;
};
