export declare function generateOtp(length?: number): string;
export declare function generateBackupCodes(count?: number, length?: number): string[];
export declare function hashOtp(otp: string): Promise<string>;
export declare function verifyOtp(otp: string, hash: string): Promise<boolean>;
