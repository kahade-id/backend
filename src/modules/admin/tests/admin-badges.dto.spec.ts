import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateBadgeDto, UpdateBadgeDto } from '../badges/dto/create-badge.dto';

describe('admin badge DTO validation', () => {
  it('trims a valid badge payload before catalog persistence', async () => {
    const dto = plainToInstance(CreateBadgeDto, {
      name: '  Early Adopter  ',
      iconUrl: '  https://cdn.kahade.id/badges/early.svg  ',
      description: '  Pengguna awal  ',
    });

    expect(await validate(dto)).toHaveLength(0);
    expect(dto).toMatchObject({
      name: 'Early Adopter',
      iconUrl: 'https://cdn.kahade.id/badges/early.svg',
      description: 'Pengguna awal',
    });
  });

  it('rejects a whitespace-only badge name after normalization', async () => {
    const dto = plainToInstance(UpdateBadgeDto, { name: '   ' });

    expect(await validate(dto)).not.toHaveLength(0);
  });
});
