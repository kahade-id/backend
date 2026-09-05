import { getBootstrapMode, getSmokeEnvFile, getSmokeLoopbackHost, selectRootModule } from './bootstrap-mode';

describe('read-only smoke bootstrap', () => {
  it('preserves the normal application graph unless SMOKE_MODE is explicitly true', () => {
    class NormalModule {}
    class SmokeModule {}

    expect(getBootstrapMode({})).toBe('normal');
    expect(getBootstrapMode({ SMOKE_MODE: 'false' })).toBe('normal');
    expect(selectRootModule(getBootstrapMode({}), NormalModule, SmokeModule)).toBe(NormalModule);
  });

  it('uses the narrow health-only root graph only when explicitly enabled', () => {
    class NormalModule {}
    class SmokeModule {}

    expect(getBootstrapMode({ SMOKE_MODE: 'true' })).toBe('read-only-smoke');
    expect(selectRootModule(getBootstrapMode({ SMOKE_MODE: 'true' }), NormalModule, SmokeModule)).toBe(SmokeModule);
  });

  it('refuses any non-loopback bind address in smoke mode', () => {
    expect(getSmokeLoopbackHost({ HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(getSmokeLoopbackHost({ HOST: '::1' })).toBe('::1');
    expect(getSmokeLoopbackHost({ HOST: 'localhost' })).toBe('localhost');
    expect(() => getSmokeLoopbackHost({ HOST: '0.0.0.0' })).toThrow(/requires HOST/);
    expect(() => getSmokeLoopbackHost({})).toThrow(/requires HOST/);
  });

  it('requires an absolute path to the existing runtime configuration', () => {
    expect(getSmokeEnvFile({ SMOKE_ENV_FILE: '/var/www/kahade/apps/backend/.env' }))
      .toBe('/var/www/kahade/apps/backend/.env');
    expect(() => getSmokeEnvFile({ SMOKE_ENV_FILE: '.env' })).toThrow(/requires SMOKE_ENV_FILE/);
    expect(() => getSmokeEnvFile({})).toThrow(/requires SMOKE_ENV_FILE/);
  });
});
