import { registerAs } from '@nestjs/config';

/**
 * into a dedicated ConfigService namespace. All variables are now documented in .env.example.
 */
export const smtpConfig = registerAs('smtp', () => ({
  host: process.env.SMTP_HOST || '',
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || 'noreply@kahade.id',
}));
