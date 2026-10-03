import { Injectable, ExecutionContext, CallHandler, NestInterceptor, PayloadTooLargeException } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * BFI-106 (audit integrasi 2026-09-30): guard multer `fileSize` melempar 413
 * SEBELUM handler berjalan (celah 100–104 MiB untuk video). Nest mengubah
 * MulterError LIMIT_FILE_SIZE menjadi `PayloadTooLargeException("File too
 * large")` TANPA kode terstruktur → HttpExceptionFilter memetakannya jadi
 * `{ code: 'UNKNOWN_ERROR' }` yang tidak bisa dipetakan FE.
 *
 * Interceptor ini (terdaftar di level controller/method → membungkus
 * FileInterceptor) menangkap 413 mentah tersebut dan melempar ulang sebagai
 * 413 `{ code: 'PAYLOAD_TOO_LARGE' }`. Exception terstruktur dari kode
 * sendiri (VIDEO_TOO_LARGE / FILE_TOO_LARGE — respons objek yang sudah
 * ber-`code`, lihat BFI-060) diteruskan APA ADANYA.
 *
 * UPV-02 (audit upload video 2026-10-03): dipindah dari UploadController ke
 * file sendiri agar bisa dipakai ulang — didaftarkan juga di
 * `ChatController.uploadChatFile` (video chat >50 MiB di jalur fail-open
 * sebelumnya jatuh ke `UNKNOWN_ERROR` generik).
 */
@Injectable()
export class MulterTooLargeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (err instanceof PayloadTooLargeException) {
          const response = err.getResponse();
          const alreadyStructured =
            typeof response === 'object' &&
            response !== null &&
            typeof (response as Record<string, unknown>).code === 'string';
          if (!alreadyStructured) {
            return throwError(
              () =>
                new PayloadTooLargeException({
                  code: 'PAYLOAD_TOO_LARGE',
                  message: 'File too large. The upload exceeds the maximum allowed size.',
                }),
            );
          }
        }
        return throwError(() => err);
      }),
    );
  }
}
