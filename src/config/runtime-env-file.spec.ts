import { getRuntimeEnvFile } from './runtime-env-file';

describe('runtime environment file', () => {
  it('preserves the default ConfigModule lookup when no release path is configured', () => {
    expect(getRuntimeEnvFile({})).toBeUndefined();
  });

  it('accepts only an explicit absolute path for an immutable release checkout', () => {
    expect(getRuntimeEnvFile({ RUNTIME_ENV_FILE: '/var/www/kahade/apps/backend/.env' }))
      .toBe('/var/www/kahade/apps/backend/.env');
    expect(() => getRuntimeEnvFile({ RUNTIME_ENV_FILE: '.env' })).toThrow(/must be an absolute path/);
  });
});
