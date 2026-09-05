export declare const databaseConfig: (() => {
    url: string;
    poolSize: number;
    poolTimeout: number;
    statementTimeout: number;
}) & import("@nestjs/config").ConfigFactoryKeyHost<{
    url: string;
    poolSize: number;
    poolTimeout: number;
    statementTimeout: number;
}>;
