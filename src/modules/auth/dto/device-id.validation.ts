export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/;
export const DEVICE_ID_MESSAGE = 'Device identifier must be 8-255 characters using letters, digits, dots, underscores, colons, or hyphens';

export function normalizeDeviceId(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}
