export declare const smtpConfig: (() => {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
}) & import("@nestjs/config").ConfigFactoryKeyHost<{
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
}>;
