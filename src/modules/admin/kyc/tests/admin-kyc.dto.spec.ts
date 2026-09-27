import { validate } from 'class-validator';
import { RejectKycDto } from '../dto/reject-kyc.dto';
import { RevokeKycDto } from '../dto/revoke-kyc.dto';
import { GetDocumentUrlsDto } from '../dto/get-document-urls.dto';
import { ReviewKycDto } from '../dto/review-kyc.dto';

describe('Admin KYC DTO whitespace boundaries', () => {
  it('rejects whitespace-only rejection reasons and notes', async () => {
    const dto = Object.assign(new RejectKycDto(), { reason: '          ', notes: '   ' });
    const errors = await validate(dto);
    expect(errors.flatMap((error) => Object.keys(error.constraints ?? {}))).toEqual(expect.arrayContaining(['matches']));
  });

  it('rejects whitespace-only revocation reason', async () => {
    const dto = Object.assign(new RevokeKycDto(), { reason: '          ' });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'reason' && error.constraints?.matches)).toBe(true);
  });

  it('rejects whitespace-only document re-auth password', async () => {
    const dto = Object.assign(new GetDocumentUrlsDto(), { password: '   ' });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'password' && error.constraints?.matches)).toBe(true);
  });

  it('rejects whitespace-only optional review notes', async () => {
    const dto = Object.assign(new ReviewKycDto(), { notes: '\n\t' });
    const errors = await validate(dto);
    expect(errors.some((error) => error.property === 'notes' && error.constraints?.matches)).toBe(true);
  });

  it('accepts a meaningful reason and omits optional notes', async () => {
    const dto = Object.assign(new RejectKycDto(), { reason: 'Dokumen tidak cocok', notes: undefined });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});

describe('Admin KYC GAP-E DTO boundaries', () => {
  const { BulkApproveKycDto, BulkRejectKycDto } = require('../dto/bulk-kyc.dto') as typeof import('../dto/bulk-kyc.dto');
  const { UpdateSlaConfigDto } = require('../dto/sla-config.dto') as typeof import('../dto/sla-config.dto');

  it('rejects bulk payloads with more than 50 ids', async () => {
    const dto = Object.assign(new BulkApproveKycDto(), {
      kycIds: Array.from({ length: 51 }, (_, i) => `KYC-${i}`),
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'kycIds' && e.constraints?.arrayMaxSize)).toBe(true);
  });

  it('rejects bulk reject without a reason of min 10 chars', async () => {
    const dto = Object.assign(new BulkRejectKycDto(), { kycIds: ['KYC-1'], reason: '  buruk  ' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'reason')).toBe(true);
  });

  it('rejects bulk expectedStatus outside PENDING', async () => {
    const dto = Object.assign(new BulkApproveKycDto(), { kycIds: ['KYC-1'], expectedStatus: 'APPROVED' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'expectedStatus' && e.constraints?.isIn)).toBe(true);
  });

  it('accepts a valid bulk approve payload', async () => {
    const dto = Object.assign(new BulkApproveKycDto(), { kycIds: ['KYC-1', 'KYC-2'], expectedStatus: 'PENDING' });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('requires changeReason >= 10 chars for SLA config updates', async () => {
    const dto = Object.assign(new UpdateSlaConfigDto(), {
      scope: 'KYC_PERSONAL',
      slaHours: 48,
      useBusinessHours: false,
      changeReason: '  pendek ',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'changeReason')).toBe(true);
  });

  it('rejects unknown SLA scope and out-of-range hours', async () => {
    const dto = Object.assign(new UpdateSlaConfigDto(), {
      scope: 'WHATEVER',
      slaHours: 9999,
      useBusinessHours: false,
      changeReason: 'Alasan perubahan yang cukup panjang',
    });
    const errors = await validate(dto);
    const props = errors.map((e) => e.property);
    expect(props).toEqual(expect.arrayContaining(['scope', 'slaHours']));
  });

  it('accepts a valid SLA config update', async () => {
    const dto = Object.assign(new UpdateSlaConfigDto(), {
      scope: 'BUSINESS_VERIFICATION',
      slaHours: 72,
      useBusinessHours: true,
      changeReason: 'Keputusan operasional tim KYC per Q4',
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
