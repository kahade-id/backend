/**
 * Audit Batch 5 — SS-016: alur presigned ditutup dengan HTTP 410 Gone.
 */
import { GoneException } from '@nestjs/common';
import { UploadController } from '../upload.controller';
import { UploadPurpose } from '../dto/presigned-url.dto';

describe('UploadController — SS-016 deprecated presigned endpoints', () => {
  const controller = new UploadController({} as never, {} as never);

  it('POST /upload/presigned-url melempar 410 Gone', async () => {
    const err = await controller
      .getPresignedUrl('user-1', { purpose: UploadPurpose.AVATAR, fileName: 'a.png', contentType: 'image/png', fileSize: 10 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GoneException);
    expect(err.getStatus()).toBe(410);
  });

  it('POST /upload/confirm melempar 410 Gone', async () => {
    const err = await controller
      .confirmUpload('user-1', { fileKey: 'private/k' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(GoneException);
    expect(err.getStatus()).toBe(410);
  });
});
