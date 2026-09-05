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
