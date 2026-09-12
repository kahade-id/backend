import { validate } from 'class-validator';
import { ExportCsvDto } from '../dto/export-csv.dto';

/**
 * R2-K (audit): `types` flowed unvalidated into the Prisma `type: { in: [...] }`
 * filter; one bogus value produced a P2023 500 on the statement export route.
 */
describe('ExportCsvDto types filter', () => {
  it('accepts valid WalletTransactionType values', async () => {
    const dto = new ExportCsvDto();
    dto.types = ['TOP_UP', 'WITHDRAW'];
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects arbitrary strings before they reach Prisma', async () => {
    const dto = new ExportCsvDto();
    dto.types = ['DROP TABLE'];
    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });
});
