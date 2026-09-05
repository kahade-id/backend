export declare const cryptoConfig: (() => {
    aesSecretKey: string;
    aesKdfSalt: string;
    hmacSecretKey: string;
    previousAesSecretKey: string;
    kycNikEncryptionKey: string;
    kycKtpEncryptionKey: string;
    kycSelfieEncryptionKey: string;
    bcryptRounds: number;
}) & import("@nestjs/config").ConfigFactoryKeyHost<{
    aesSecretKey: string;
    aesKdfSalt: string;
    hmacSecretKey: string;
    previousAesSecretKey: string;
    kycNikEncryptionKey: string;
    kycKtpEncryptionKey: string;
    kycSelfieEncryptionKey: string;
    bcryptRounds: number;
}>;
