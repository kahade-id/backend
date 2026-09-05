import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { getBcryptRounds } from './crypto.util';

// SEC-019: Default OTP length is 6 digits (10^6 = 1M combinations), suitable for
// general authentication flows (email verification, password reset, 2FA disable).
// For financial operations (withdraw confirmation), consider using 8-digit OTPs
// (10^8 = 100M combinations) by passing length=8 to generateOtp().

function uniformByte(max: number): number {
  const limit = 256 - (256 % max);
  let b: number;
  do { b = randomBytes(1)[0]; } while (b >= limit);
  return b % max;
}

export function generateOtp(length = 6): string {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) otp += digits.charAt(uniformByte(digits.length));
  return otp;
}

export function generateBackupCodes(count = 10, length = 16): string[] {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    for (let j = 0; j < length; j++) code += chars.charAt(uniformByte(chars.length));
    codes.push(code);
  }
  return codes;
}

export async function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, getBcryptRounds());
}

export async function verifyOtp(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}
