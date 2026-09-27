// GAP-F (G452/G453/G455/G456/G457): Partner client + API key lifecycle service.
// Admin-facing. Plaintext keys are returned ONCE at issue/rotate time and never
// persisted. All mutations write a PartnerAuditLog entry.

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PARTNER_KEY_ROTATION_OVERLAP_MS } from './partner.constants';
import {
  generatePartnerApiKey,
  hashPartnerApiKey,
} from './partner-api-key.util';
import {
  CreatePartnerClientDto,
  IssuePartnerKeyDto,
  RevokePartnerKeyDto,
  UpdatePartnerClientDto,
} from './dto/partner.dto';

export interface ApiClientRecord {
  id: string;
  orgName: string;
  ownerUserId: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  isSandbox: boolean;
  rateLimitPerMinute: number;
  quotaPerDay: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PartnerApiKeyRecord {
  id: string;
  clientId: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  name: string | null;
  expiresAt: Date | null;
  rotatedFromId: string | null;
  validUntil: Date | null;
  revokedAt: Date | null;
  revokeReason: string | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

interface PartnerPrisma {
  apiClient: {
    create(args: unknown): Promise<ApiClientRecord>;
    findMany(args?: unknown): Promise<ApiClientRecord[]>;
    findUnique(args: unknown): Promise<(ApiClientRecord & { keys?: PartnerApiKeyRecord[] }) | null>;
    update(args: unknown): Promise<ApiClientRecord>;
    count(args?: unknown): Promise<number>;
  };
  partnerApiKey: {
    create(args: unknown): Promise<PartnerApiKeyRecord>;
    findUnique(args: unknown): Promise<(PartnerApiKeyRecord & { client?: ApiClientRecord }) | null>;
    findMany(args?: unknown): Promise<PartnerApiKeyRecord[]>;
    update(args: unknown): Promise<PartnerApiKeyRecord>;
  };
  partnerAuditLog: {
    create(args: unknown): Promise<unknown>;
    findMany(args?: unknown): Promise<unknown[]>;
  };
}

@Injectable()
export class PartnerClientService {
  private readonly logger = new Logger(PartnerClientService.name);

  constructor(private readonly prisma: PrismaService) {}

  private get p(): PartnerPrisma {
    return this.prisma as unknown as PartnerPrisma;
  }

  // ---------- Clients ----------

  async createClient(dto: CreatePartnerClientDto, adminId: string, ip: string): Promise<ApiClientRecord> {
    const client = await this.p.apiClient.create({
      data: {
        orgName: dto.orgName.trim(),
        ownerUserId: dto.ownerUserId ?? null,
        status: 'ACTIVE',
        isSandbox: dto.isSandbox ?? false,
        rateLimitPerMinute: dto.rateLimitPerMinute ?? 100,
        quotaPerDay: dto.quotaPerDay ?? 10000,
      },
    });
    await this.audit(adminId, 'CLIENT_CREATED', client.id, `Client "${client.orgName}" dibuat`, ip, undefined, 'ApiClient');
    return client;
  }

  async listClients(page = 1, limit = 20): Promise<{ items: ApiClientRecord[]; total: number }> {
    const [items, total] = await Promise.all([
      this.p.apiClient.findMany({ orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.p.apiClient.count(),
    ]);
    return { items, total };
  }

  /** Client detail: keys WITHOUT hashes/secrets (G457). */
  async getClient(id: string): Promise<unknown> {
    const client = await this.p.apiClient.findUnique({
      where: { id },
      include: { keys: { orderBy: { createdAt: 'desc' } } },
    });
    if (!client) throw new NotFoundException({ code: 'PARTNER_CLIENT_NOT_FOUND', message: 'Client tidak ditemukan' });
    const keys = (client.keys ?? []).map((k) => this.redactKey(k));
    return { ...client, keys };
  }

  async updateClient(id: string, dto: UpdatePartnerClientDto, adminId: string, ip: string): Promise<ApiClientRecord> {
    const existing = await this.p.apiClient.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ code: 'PARTNER_CLIENT_NOT_FOUND', message: 'Client tidak ditemukan' });
    const client = await this.p.apiClient.update({ where: { id }, data: dto });
    await this.audit(
      adminId,
      'CLIENT_UPDATED',
      id,
      `Client "${client.orgName}" diperbarui`,
      ip,
      {
        before: { status: existing.status },
        after: { status: client.status },
      },
      'ApiClient',
    );
    return client;
  }

  // ---------- Keys ----------

  /** Issue a key. Plaintext returned ONCE — never stored (G453). */
  async issueKey(
    clientId: string,
    dto: IssuePartnerKeyDto,
    adminId: string,
    ip: string,
  ): Promise<{ key: PartnerApiKeyRecord; plaintext: string }> {
    const client = await this.p.apiClient.findUnique({ where: { id: clientId } });
    if (!client) throw new NotFoundException({ code: 'PARTNER_CLIENT_NOT_FOUND', message: 'Client tidak ditemukan' });
    if (client.status !== 'ACTIVE') {
      throw new BadRequestException({ code: 'PARTNER_CLIENT_INACTIVE', message: 'Client tidak aktif' });
    }

    const { plaintext, keyPrefix, isSandbox } = generatePartnerApiKey(client.isSandbox);
    if (isSandbox !== client.isSandbox) {
      throw new BadRequestException({ code: 'PARTNER_KEY_ENV_MISMATCH', message: 'Lingkungan key tidak cocok' });
    }
    const keyHash = await hashPartnerApiKey(plaintext);
    const key = await this.p.partnerApiKey.create({
      data: {
        clientId,
        keyPrefix,
        keyHash,
        scopes: dto.scopes,
        name: dto.name,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      },
    });
    await this.audit(adminId, 'KEY_ISSUED', key.id, `Key "${dto.name}" diterbitkan untuk client "${client.orgName}"`, ip, {
      after: { clientId, keyPrefix, scopes: dto.scopes },
    });
    this.logger.log(`Issued partner key ${keyPrefix}*** for client ${clientId}`);
    return { key, plaintext };
  }

  /** Rotate: new key issued; old key stays valid for 24h overlap (G455). */
  async rotateKey(
    clientId: string,
    keyId: string,
    dto: IssuePartnerKeyDto,
    adminId: string,
    ip: string,
  ): Promise<{ key: PartnerApiKeyRecord; plaintext: string }> {
    const oldKey = await this.p.partnerApiKey.findUnique({
      where: { id: keyId },
      include: { client: true },
    });
    if (!oldKey || oldKey.clientId !== clientId) {
      throw new NotFoundException({ code: 'PARTNER_KEY_NOT_FOUND', message: 'Key tidak ditemukan' });
    }
    if (oldKey.revokedAt) {
      throw new BadRequestException({ code: 'PARTNER_KEY_REVOKED', message: 'Key sudah di-revoke' });
    }

    const { key: newKey, plaintext } = await this.issueKey(clientId, dto, adminId, ip);
    // Mark lineage + overlap window on the OLD key.
    const validUntil = new Date(Date.now() + PARTNER_KEY_ROTATION_OVERLAP_MS);
    await this.p.partnerApiKey.update({ where: { id: keyId }, data: { validUntil } });
    await this.p.partnerApiKey.update({ where: { id: newKey.id }, data: { rotatedFromId: keyId } });
    await this.audit(
      adminId,
      'KEY_ROTATED',
      newKey.id,
      `Key dirotasi; key lama valid hingga ${validUntil.toISOString()} (overlap 24 jam)`,
      ip,
      { before: { keyId }, after: { newKeyId: newKey.id, validUntil } },
    );
    return { key: { ...newKey, rotatedFromId: keyId }, plaintext };
  }

  /** Instant revoke with mandatory reason (G456). */
  async revokeKey(clientId: string, keyId: string, dto: RevokePartnerKeyDto, adminId: string, ip: string): Promise<PartnerApiKeyRecord> {
    const key = await this.p.partnerApiKey.findUnique({ where: { id: keyId } });
    if (!key || key.clientId !== clientId) {
      throw new NotFoundException({ code: 'PARTNER_KEY_NOT_FOUND', message: 'Key tidak ditemukan' });
    }
    if (key.revokedAt) {
      throw new ConflictException({ code: 'PARTNER_KEY_ALREADY_REVOKED', message: 'Key sudah di-revoke' });
    }
    const revoked = await this.p.partnerApiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date(), revokeReason: dto.reason.trim(), validUntil: null },
    });
    await this.audit(adminId, 'KEY_REVOKED', keyId, `Key "${key.name ?? keyId}" di-revoke: ${dto.reason.trim()}`, ip, {
      before: { keyPrefix: key.keyPrefix },
      after: { revokedAt: revoked.revokedAt, reason: dto.reason.trim() },
    });
    this.logger.warn(`Revoked partner key ${key.keyPrefix}*** (client ${clientId}): ${dto.reason.trim()}`);
    return revoked;
  }

  // ---------- Helpers ----------

  private redactKey(k: PartnerApiKeyRecord): Record<string, unknown> {
    const { keyHash: _hash, ...rest } = k;
    void _hash; // never expose the hash
    return { ...rest, keyPrefix: `${k.keyPrefix}***` };
  }

  private async audit(
    adminId: string,
    action: string,
    targetId: string,
    description: string,
    ip: string,
    diff?: { before?: unknown; after?: unknown },
    targetType = 'PartnerApiKey',
  ): Promise<void> {
    try {
      await this.p.partnerAuditLog.create({
        data: {
          adminId,
          action,
          targetType,
          targetId,
          description,
          before: diff?.before ?? null,
          after: diff?.after ?? null,
          ipAddress: ip,
        },
      });
    } catch (err) {
      // Audit failure must not break the security action itself; log loudly.
      this.logger.error(`PartnerAuditLog write failed: ${(err as Error).message}`);
    }
  }

  async getAuditLog(clientId: string, limit = 50): Promise<unknown[]> {
    return this.p.partnerAuditLog.findMany({
      where: { targetId: clientId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
