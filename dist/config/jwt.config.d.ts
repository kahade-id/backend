export declare const jwtConfig: (() => {
    secret: string;
    expiresIn: string;
    refreshSecret: string;
    refreshExpiresIn: string;
    adminSecret: string;
    adminExpiresIn: string;
    adminRefreshSecret: string;
    adminRefreshExpiresIn: string;
    tempExpiresIn: string;
    tempSecret: string;
}) & import("@nestjs/config").ConfigFactoryKeyHost<{
    secret: string;
    expiresIn: string;
    refreshSecret: string;
    refreshExpiresIn: string;
    adminSecret: string;
    adminExpiresIn: string;
    adminRefreshSecret: string;
    adminRefreshExpiresIn: string;
    tempExpiresIn: string;
    tempSecret: string;
}>;
