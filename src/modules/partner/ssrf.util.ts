// GAP-F (G470/G471): SSRF-safe webhook URL validation.
// - https only
// - DNS resolve, then every resolved IP is checked against private/loopback/
//   link-local/reserved/multicast ranges and cloud metadata endpoints
// - optional PARTNER_EGRESS_ALLOWLIST (comma-separated CIDRs) enforcement

import { lookup } from 'dns/promises';
import { isIP, BlockList } from 'net';

export class WebhookUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlValidationError';
  }
}

const METADATA_HOSTNAMES = new Set([
  '169.254.169.254', // AWS/GCP/Azure/DigitalOcean metadata
  'metadata.google.internal',
  'metadata.google.com',
  'instance-data',
  'instance-data-compute',
]);

const BLOCKED_RANGES = [
  '0.0.0.0/8', // software scope
  '10.0.0.0/8', // private
  '100.64.0.0/10', // carrier-grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local (incl. cloud metadata)
  '172.16.0.0/12', // private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1 (documentation)
  '192.88.99.0/24', // reserved (6to4 relay anycast)
  '192.168.0.0/16', // private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2
  '203.0.113.0/24', // TEST-NET-3
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
  '255.255.255.255/32', // broadcast
  '::1/128', // loopback
  '::/128', // unspecified
  '::ffff:0:0/96', // IPv4-mapped
  '64:ff9b::/96', // IPv4-IPv6 translation
  '100::/64', // discard
  '2001::/23', // special purpose
  '2001:db8::/32', // documentation
  'fc00::/7', // unique local
  'fe80::/10', // link-local
  'ff00::/8', // multicast
];

const v4Blocked = new BlockList();
const v6Blocked = new BlockList();
for (const range of BLOCKED_RANGES) {
  const [addr, prefix] = range.split('/');
  const isV6 = addr.includes(':');
  // NOTE: '::ffff:0:0/96' (IPv4-mapped) is intentionally handled via the
  // embedded-IPv4 check in isBlockedIp below, not as a blanket v6 rule —
  // adding it as a v6 rule makes EVERY IPv4 address match (Node maps IPv4
  // inputs to ::ffff:0:0/96 during check).
  if (addr === '::ffff:0:0') continue;
  (isV6 ? v6Blocked : v4Blocked).addSubnet(addr, Number(prefix), isV6 ? 'ipv6' : 'ipv4');
}

function parseAllowlist(): BlockList | null {
  const raw = process.env.PARTNER_EGRESS_ALLOWLIST?.trim();
  if (!raw) return null;
  const list = new BlockList();
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, prefix] = entry.includes('/') ? entry.split('/') : [entry, entry.includes(':') ? '128' : '32'];
    list.addSubnet(addr, Number(prefix), addr.includes(':') ? 'ipv6' : 'ipv4');
  }
  return list;
}

/** Validate a webhook endpoint URL. Throws WebhookUrlValidationError. Returns normalized URL. */
export async function validateWebhookUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookUrlValidationError('URL tidak valid');
  }

  if (url.protocol !== 'https:') {
    throw new WebhookUrlValidationError('URL webhook harus HTTPS');
  }
  if (url.username || url.password) {
    throw new WebhookUrlValidationError('URL webhook tidak boleh memuat kredensial');
  }
  if (url.port && url.port !== '443') {
    throw new WebhookUrlValidationError('URL webhook hanya boleh memakai port 443 (atau tanpa port eksplisit)');
  }

  const hostname = url.hostname.toLowerCase();
  if (METADATA_HOSTNAMES.has(hostname)) {
    throw new WebhookUrlValidationError('URL mengarah ke endpoint metadata cloud — ditolak');
  }
  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new WebhookUrlValidationError('Alamat IP termasuk rentang private/reserved — ditolak (anti-SSRF)');
    }
  } else {
    // Resolve DNS (all results), then check every IP — anti DNS-rebinding TOCTOU dasar.
    let addrs: { address: string }[];
    try {
      addrs = await lookup(hostname, { all: true });
    } catch {
      throw new WebhookUrlValidationError('Hostname tidak dapat di-resolve');
    }
    for (const { address } of addrs) {
      if (isBlockedIp(address)) {
        throw new WebhookUrlValidationError(
          `Hostname me-resolve ke alamat private/reserved (${redactIp(address)}) — ditolak (anti-SSRF)`,
        );
      }
    }
    const allowlist = parseAllowlist();
    if (allowlist) {
      const allAllowed = addrs.every(({ address }) => allowlist.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4'));
      if (!allAllowed) {
        throw new WebhookUrlValidationError('Alamat di luar PARTNER_EGRESS_ALLOWLIST — ditolak');
      }
    }
  }

  return url.toString();
}

/** True when the IP is in a blocked private/reserved range. Exported for tests. */
export function isBlockedIp(ip: string): boolean {
  try {
    if (isIP(ip) === 6) {
      // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1): check the embedded IPv4.
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
      if (mapped) return isBlockedIp(mapped[1]);
      return v6Blocked.check(ip, 'ipv6');
    }
    return v4Blocked.check(ip, 'ipv4');
  } catch {
    return true; // fail-closed on unparseable input
  }
}

function redactIp(ip: string): string {
  // Never echo full internal IPs back in detail; keep a short hint for debugging.
  return ip.length > 7 ? `${ip.slice(0, 3)}***` : '***';
}
