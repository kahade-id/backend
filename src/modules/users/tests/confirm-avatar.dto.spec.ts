import { validate } from 'class-validator';
import { ConfirmAvatarDto } from '../dto/confirm-avatar.dto';

/**
 * R2-N (audit): the DTO regex required `avatars/<name>.<ext>` (two segments), but
 * the presigned flow mints `avatars/<userId>/<nanoid>.<ext>` (three segments) — so
 * EVERY confirm request for an honestly generated key was rejected with 400 and
 * the presigned avatar upload could never be published.
 */
async function check(avatarKey: string): Promise<boolean> {
  const dto = new ConfirmAvatarDto();
  dto.avatarKey = avatarKey;
  return (await validate(dto)).length === 0;
}

describe('ConfirmAvatarDto', () => {
  it('accepts the real presigned key shape', async () => {
    await expect(check('avatars/cme1x8z4q0002h5rk9abc1234/V1StGXR8_Z5jdHi6B.jpg')).resolves.toBe(true);
    await expect(check('avatars/usr_1/abcdefgh12345678.webp')).resolves.toBe(true);
  });

  it('rejects traversal, foreign prefixes and wrong extensions', async () => {
    await expect(check('avatars/../etc/passwd')).resolves.toBe(false);
    await expect(check('uploads/anything/x.jpg')).resolves.toBe(false);
    await expect(check('avatars/usr_1/file.exe')).resolves.toBe(false);
    await expect(check('avatars/usr_1/../../x.png')).resolves.toBe(false);
  });
});
