/**
 * ADM-313 — perubahan status partner fail-closed: wajib alasan min. 10
 * karakter (server-side), alasan audit-only (tidak diteruskan ke Prisma).
 *
 * Cakupan:
 * - status berubah tanpa alasan → 400 PARTNER_STATUS_REASON_REQUIRED,
 *   prisma.apiClient.update TIDAK dipanggil.
 * - status berubah dengan alasan < 10 char → 400 yang sama.
 * - status berubah dengan alasan valid → sukses; `data` ke Prisma tidak
 *   mengandung `reason`; deskripsi audit memuat alasan.
 * - update non-status / status sama → alasan tidak wajib.
 */
import 'reflect-metadata';
import { PartnerClientService } from '../partner-client.service';

function codeOf(err: unknown): string | undefined {
  if (err && typeof (err as { getResponse?: unknown }).getResponse === 'function') {
    const res = (err as { getResponse: () => unknown }).getResponse();
    if (res && typeof res === 'object') return (res as { code?: string }).code;
  }
  return undefined;
}

function makeService(existingStatus: 'ACTIVE' | 'SUSPENDED' | 'REVOKED' = 'ACTIVE') {
  const prisma: any = {
    apiClient: {
      findUnique: jest.fn().mockResolvedValue({ id: 'client-1', orgName: 'Mitra Uji', status: existingStatus }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'client-1', orgName: 'Mitra Uji', status: data.status ?? existingStatus }),
      ),
    },
    partnerAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const service = new PartnerClientService(prisma);
  return { service, prisma };
}

describe('ADM-313 updateClient — alasan wajib saat status berubah', () => {
  it('status berubah tanpa alasan → 400 PARTNER_STATUS_REASON_REQUIRED, update tidak dipanggil', async () => {
    const { service, prisma } = makeService('ACTIVE');
    const err = await service
      .updateClient('client-1', { status: 'SUSPENDED' }, 'admin-1', '127.0.0.1')
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PARTNER_STATUS_REASON_REQUIRED');
    expect(prisma.apiClient.update).not.toHaveBeenCalled();
    expect(prisma.partnerAuditLog.create).not.toHaveBeenCalled();
  });

  it('alasan < 10 karakter → 400', async () => {
    const { service, prisma } = makeService('ACTIVE');
    const err = await service
      .updateClient('client-1', { status: 'REVOKED', reason: 'nakal' }, 'admin-1', '127.0.0.1')
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('PARTNER_STATUS_REASON_REQUIRED');
    expect(prisma.apiClient.update).not.toHaveBeenCalled();
  });

  it('alasan valid → sukses; reason tidak diteruskan ke Prisma; audit memuat alasan', async () => {
    const { service, prisma } = makeService('ACTIVE');
    const res = await service.updateClient(
      'client-1',
      { status: 'SUSPENDED', reason: 'Pelanggaran syarat layanan berulang' },
      'admin-1',
      '127.0.0.1',
    );
    expect(res.status).toBe('SUSPENDED');
    const data = prisma.apiClient.update.mock.calls[0][0].data;
    expect(data.status).toBe('SUSPENDED');
    expect(data).not.toHaveProperty('reason');
    const audit = prisma.partnerAuditLog.create.mock.calls[0][0];
    expect(JSON.stringify(audit)).toContain('Pelanggaran syarat layanan berulang');
  });

  it('status sama atau update non-status → alasan tidak wajib', async () => {
    const { service, prisma } = makeService('ACTIVE');
    await service.updateClient('client-1', { status: 'ACTIVE' }, 'admin-1', '127.0.0.1');
    expect(prisma.apiClient.update).toHaveBeenCalledTimes(1);
    await service.updateClient('client-1', { orgName: 'Nama Baru' }, 'admin-1', '127.0.0.1');
    expect(prisma.apiClient.update).toHaveBeenCalledTimes(2);
  });
});
