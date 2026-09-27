// GAP-F (G454): scope metadata decorator for partner endpoints.
import { SetMetadata } from '@nestjs/common';
import { PartnerScope } from './partner.constants';

export const PARTNER_SCOPES_KEY = 'partnerScopes';
export const PartnerScopes = (...scopes: PartnerScope[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(PARTNER_SCOPES_KEY, scopes);

export const PARTNER_AUTH_KEY = 'partnerAuth';
/** Marks a partner controller/handler as authenticated via API key (not JWT). */
export const PartnerAuth = (): ReturnType<typeof SetMetadata> => SetMetadata(PARTNER_AUTH_KEY, true);

/** Partner client + validated key identity attached to the request by PartnerApiKeyGuard. */
export interface PartnerRequestIdentity {
  clientId: string;
  keyId: string;
  keyName: string | null;
  scopes: string[];
  isSandbox: boolean;
  rateLimitPerMinute: number;
  quotaPerDay: number;
}
