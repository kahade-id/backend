/**
 * ADM-303 — validasi incident di controller harus fail-closed 400 dengan
 * kode eksplisit, bukan Error mentah (yang akan jadi 500).
 *
 * Cakupan:
 * - title/description kosong → 400 INCIDENT_TITLE_DESCRIPTION_REQUIRED
 * - severity tidak valid → 400 INCIDENT_SEVERITY_INVALID
 * - status tidak valid saat update → 400 INCIDENT_STATUS_INVALID
 * - PII di title/description → 400 INCIDENT_PII_DETECTED (bukan 500)
 */
import 'reflect-metadata';
import { IncidentsController } from './incidents.controller';

function codeOf(err: unknown): string | undefined {
  if (err && typeof (err as { getResponse?: unknown }).getResponse === 'function') {
    const res = (err as { getResponse: () => unknown }).getResponse();
    if (res && typeof res === 'object') return (res as { code?: string }).code;
  }
  return undefined;
}

function makeController() {
  const incidentLog = {
    create: jest.fn().mockResolvedValue({ id: 'inc-1' }),
    update: jest.fn().mockResolvedValue({ id: 'inc-1' }),
    findMany: jest.fn().mockResolvedValue([]),
  };
  const prisma = { incidentLog } as never;
  return { controller: new IncidentsController(prisma), incidentLog };
}

describe('ADM-303 IncidentsController validation', () => {
  it('title/description kosong → 400 INCIDENT_TITLE_DESCRIPTION_REQUIRED', async () => {
    const { controller, incidentLog } = makeController();
    const err = await controller
      .create({ title: '  ', description: '', severity: 'SEV1', component: 'api' })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('INCIDENT_TITLE_DESCRIPTION_REQUIRED');
    expect(incidentLog.create).not.toHaveBeenCalled();
  });

  it('severity tidak valid → 400 INCIDENT_SEVERITY_INVALID', async () => {
    const { controller, incidentLog } = makeController();
    const err = await controller
      .create({ title: 'DB down', description: 'Latensi tinggi', severity: 'KRITIS', component: 'api' })
      .catch((e: unknown) => e);
    expect(codeOf(err)).toBe('INCIDENT_SEVERITY_INVALID');
    expect(incidentLog.create).not.toHaveBeenCalled();
  });

  it('status tidak valid saat update → 400 INCIDENT_STATUS_INVALID', async () => {
    const { controller, incidentLog } = makeController();
    const err = await controller.update('inc-1', { status: 'SELESAI' }).catch((e: unknown) => e);
    expect(codeOf(err)).toBe('INCIDENT_STATUS_INVALID');
    expect(incidentLog.update).not.toHaveBeenCalled();
  });

  it('PII di title/description → 400 INCIDENT_PII_DETECTED (bukan 500)', async () => {
    const { controller, incidentLog } = makeController();
    const phone = await controller
      .create({ title: 'Lapor ke 081234567890', description: 'ok', severity: 'SEV4', component: 'api' })
      .catch((e: unknown) => e);
    expect(codeOf(phone)).toBe('INCIDENT_PII_DETECTED');
    const email = await controller
      .create({ title: 'ok', description: 'hubungi admin@kahade.id', severity: 'SEV4', component: 'api' })
      .catch((e: unknown) => e);
    expect(codeOf(email)).toBe('INCIDENT_PII_DETECTED');
    const nik = await controller
      .update('inc-1', { description: 'NIK 3201234567890123' })
      .catch((e: unknown) => e);
    expect(codeOf(nik)).toBe('INCIDENT_PII_DETECTED');
    expect(incidentLog.create).not.toHaveBeenCalled();
    expect(incidentLog.update).not.toHaveBeenCalled();
  });

  it('payload valid lolos ke prisma', async () => {
    const { controller, incidentLog } = makeController();
    await controller.create({ title: 'Latensi API', description: 'p95 naik', severity: 'SEV4', component: 'api' });
    expect(incidentLog.create).toHaveBeenCalledTimes(1);
    await controller.update('inc-1', { status: 'RESOLVED' });
    expect(incidentLog.update).toHaveBeenCalledTimes(1);
  });
});
