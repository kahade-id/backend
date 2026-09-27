// GAP-F (G453/G458): API-key authentication guard for /v1/partner/* and /v1/partner-sandbox/*.
// Accepts: X-Api-Key header, or Authorization: ApiKey <key>.
// Never JWT. Attaches PartnerRequestIdentity to req.partner.

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PARTNER_API_KEY_AUTH_SCHEME,
  PARTNER_API_KEY_HEADER,
  PARTNER_KEY_ROTATION_OVERLAP_MS,
} from './partner.constants';
import { PARTNER_AUTH_KEY, PartnerRequestIdentity } from './partner.decorators';
import { partnerKeyIdent, verifyPartnerApiKey } from './partner-api-key.util';

@Injectable()
export class PartnerApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(PartnerApiKeyGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(PARTNER_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required) return true;

    const req = context.switchToHttp().getRequest();
    const presented = this.extractKey(req);
    if (!presented) {
      throw new UnauthorizedException({ code: 'PARTNER_UNAUTHORIZED', message: 'API key mitra diperlukan' });
    }

    const identity = await this.validateKey(presented, req.path ?? '');
    if (!identity) {
      throw new UnauthorizedException({ code: 'PARTNER_UNAUTHORIZED', message: 'API key tidak valid' });
    }
    req.partner = identity;
    return true;
  }

  private extractKey(req: { headers?: Record<string, unknown> }): string | null {
    const headerKey = req.headers?.[PARTNER_API_KEY_HEADER];
    if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
    const auth = req.headers?.['authorization'];
    if (typeof auth === 'string') {
      const [scheme, token] = auth.split(' ');
      if (scheme?.toLowerCase() === PARTNER_API_KEY_AUTH_SCHEME && token) return token.trim();
    }
    return null;
  }

  private async validateKey(presented: string, path: string): Promise<PartnerRequestIdentity | null> {
    const ident = partnerKeyIdent(presented);
    if (!ident) return null;

    const prisma = this.prisma as unknown as {
      partnerApiKey: {
        findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
        update: (args: unknown) => Promise<unknown>;
      };
      apiClient: { findUnique: (args: unknown) => Promise<Record<string, unknown> | null> };
    };

    // Narrow by 8-char prefix first (index), then constant-time scrypt compare.
    const candidates = await prisma.partnerApiKey.findMany({
      where: { keyPrefix: ident, revokedAt: null },
      include: { client: true },
    });

    for (const key of candidates) {
      const client = key['client'] as Record<string, unknown> | undefined;
      if (!client || client['status'] !== 'ACTIVE') continue;
      if (key['expiresAt'] && new Date(key['expiresAt'] as string) < new Date()) continue;
      // Rotation overlap: rotated key remains valid until validUntil (G455).
      if (key['validUntil'] && new Date(key['validUntil'] as string) < new Date()) continue;

      if (!(await verifyPartnerApiKey(presented, key['keyHash'] as string))) continue;

      // Sandbox isolation (G458): sandbox keys rejected on production partner routes.
      const clientIsSandbox = client['isSandbox'] === true;
      const isSandboxRoute = path.startsWith('/v1/partner-sandbox/');
      const isProdRoute = path.startsWith('/v1/partner/') && !isSandboxRoute;
      if (clientIsSandbox && isProdRoute) {
        this.logger.warn(`Sandbox key attempted production route: ${path}`);
        return null;
      }
      if (!clientIsSandbox && isSandboxRoute) {
        return null;
      }

      // Update lastUsedAt (best-effort, non-blocking).
      void prisma.partnerApiKey.update({ where: { id: key['id'] as string }, data: { lastUsedAt: new Date() } }).catch(() => {});

      return {
        clientId: client['id'] as string,
        keyId: key['id'] as string,
        keyName: (key['name'] as string) ?? null,
        scopes: (key['scopes'] as string[]) ?? [],
        isSandbox: clientIsSandbox,
        rateLimitPerMinute: Number(client['rateLimitPerMinute'] ?? 100),
        quotaPerDay: Number(client['quotaPerDay'] ?? 10000),
      };
    }
    return null;
  }
}

/** Exported for unit tests: rotation-overlap expiry check. */
export function isKeyWithinOverlap(validUntil: Date | null, now = new Date()): boolean {
  if (!validUntil) return true;
  return validUntil.getTime() >= now.getTime() && validUntil.getTime() - now.getTime() <= PARTNER_KEY_ROTATION_OVERLAP_MS;
}
