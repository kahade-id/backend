import { UnprocessableEntityException, ValidationError } from '@nestjs/common';

/**
 * Batch 139 BE-API2 (item 120): exceptionFactory untuk ValidationPipe global.
 *
 * Error validasi dikembalikan sebagai 422 dengan ATRIBUSI FIELD per error
 * (`fields: [{ field, messages }]`), sehingga klien bisa menampilkan pesan
 * tepat di field yang salah — tanpa menebak dari string pesan.
 *
 * KEAMANAN (jangan dilonggarkan):
 * - `ValidationError.target` (instance DTO berisi nilai yang dikirim) dan
 *   `ValidationError.value` TIDAK PERNAH disertakan — hanya nama property
 *   + pesan constraint (aturan, bukan data).
 * - Jumlah field & pesan dibatasi agar satu request jahat tidak menghasilkan
 *   respons raksasa.
 */
export interface FieldValidationError {
  /** Nama field; nested memakai path titik, mis. `items.0.name`. */
  field: string;
  /** Pesan constraint class-validator untuk field ini. */
  messages: string[];
  children?: FieldValidationError[];
}

const MAX_FIELDS = 50;
const MAX_MESSAGES_PER_FIELD = 10;
const MAX_FIELD_PATH_LENGTH = 200;

function sanitizeFieldPath(path: string): string {
  // Hanya karakter aman untuk nama field/path — cegah injeksi aneh ke log/UI.
  const cleaned = path.replace(/[^a-zA-Z0-9_.\-[\]]/g, '').slice(0, MAX_FIELD_PATH_LENGTH);
  return cleaned || 'unknown';
}

function mapValidationError(error: ValidationError, parentPath = ''): FieldValidationError {
  const rawPath = parentPath ? `${parentPath}.${error.property}` : String(error.property ?? '');
  const field = sanitizeFieldPath(rawPath);
  const messages = error.constraints
    ? Object.values(error.constraints).slice(0, MAX_MESSAGES_PER_FIELD).map(String)
    : [];
  const mapped: FieldValidationError = { field, messages };
  if (error.children && error.children.length > 0) {
    mapped.children = error.children.slice(0, MAX_FIELDS).map((child) => mapValidationError(child, rawPath));
  }
  return mapped;
}

/**
 * Dipakai sebagai `exceptionFactory` ValidationPipe global di main.ts.
 * Selalu melempar 422 — TIDAK PERNAH menyertakan target/value (data user).
 */
export function validationExceptionFactory(errors: ValidationError[]): UnprocessableEntityException {
  const fields = (Array.isArray(errors) ? errors : []).slice(0, MAX_FIELDS).map((e) => mapValidationError(e));
  return new UnprocessableEntityException({
    code: 'VALIDATION_ERROR',
    message: 'Validation failed',
    fields,
  });
}
