export declare function normalizePhoneNumber(phone: string): string;
export declare function hashPhoneNumber(phone: string): string;
export declare function encryptPii(value: string): Promise<string>;
export declare function decryptPii(value: string): Promise<string>;
export declare function decryptPiiSafe(value: string | null | undefined): Promise<string | null>;
