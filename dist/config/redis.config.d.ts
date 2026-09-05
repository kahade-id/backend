export declare const redisConfig: (() => {
    url: string;
    prefix: string;
    bullRedisUrl: string;
    bullEmailConcurrency: number;
    bullNotifConcurrency: number;
}) & import("@nestjs/config").ConfigFactoryKeyHost<{
    url: string;
    prefix: string;
    bullRedisUrl: string;
    bullEmailConcurrency: number;
    bullNotifConcurrency: number;
}>;
