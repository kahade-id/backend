// GAP-F (G453): API key generation + scrypt hashing.
// Plaintext is returned ONCE at creation and never stored. Only the scrypt
// hash is persisted. Self-contained (does not depend on global crypto init).

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { promisify } from 'util';
import {
  PARTNER_KEY_PREFIX_LIVE,
  PARTNER_KEY_PREFIX_SANDBOX,
  PARTNER_KEY_RANDOM_BYTES,
  PARTNER_KEY_IDENT_LENGTH,
} from './partner.constants';

const scryptAsync = promisify(scryptCb) as unknown as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function extractRandomPart(key: string): string | null {
  for (const prefix of [PARTNER_KEY_PREFIX_LIVE, PARTNER_KEY_PREFIX_SANDBOX]) {
    if (key.startsWith(prefix)) return key.slice(prefix.length);
  }
  return null;
}

/** Generate a new API key. Returns { plaintext, keyPrefix, isSandbox }. */
export function generatePartnerApiKey(isSandbox: boolean): {
  plaintext: string;
  keyPrefix: string;
  isSandbox: boolean;
} {
  const rand = b64url(randomBytes(PARTNER_KEY_RANDOM_BYTES));
  const prefix = isSandbox ? PARTNER_KEY_PREFIX_SANDBOX : PARTNER_KEY_PREFIX_LIVE;
  const plaintext = `${prefix}${rand}`;
  return { plaintext, keyPrefix: rand.slice(0, PARTNER_KEY_IDENT_LENGTH), isSandbox };
}

/** scrypt hash stored in DB: $scrypt$N=...,r=...,p=...$<salt>$<hash> */
export async function hashPartnerApiKey(plaintext: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(plaintext, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;
  return `$scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${b64url(salt)}$${b64url(derived)}`;
}

/** Constant-time verification of a plaintext key against the stored hash. */
export async function verifyPartnerApiKey(plaintext: string, stored: string): Promise<boolean> {
  try {
    const m = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
    if (!m) return false;
    const [, n, r, p, saltB64, hashB64] = m;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const derived = (await scryptAsync(plaintext, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    })) as Buffer;
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Extract the 8-char identification prefix from a presented key (for DB lookup). */
export function partnerKeyIdent(plaintext: string): string | null {
  const rand = extractRandomPart(plaintext);
  if (!rand || rand.length < PARTNER_KEY_IDENT_LENGTH) return null;
  return rand.slice(0, PARTNER_KEY_IDENT_LENGTH);
}

/** True when the presented key belongs to a sandbox client. */
export function partnerKeyIsSandbox(plaintext: string): boolean | null {
  if (plaintext.startsWith(PARTNER_KEY_PREFIX_SANDBOX)) return true;
  if (plaintext.startsWith(PARTNER_KEY_PREFIX_LIVE)) return false;
  return null;
}
