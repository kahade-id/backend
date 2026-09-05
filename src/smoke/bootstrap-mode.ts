import { Type } from '@nestjs/common';

export const SMOKE_MODE_ENV = 'SMOKE_MODE';
export const SMOKE_ENV_FILE_ENV = 'SMOKE_ENV_FILE';

export type BootstrapMode = 'normal' | 'read-only-smoke';

type RuntimeEnvironment = NodeJS.ProcessEnv;

export function getBootstrapMode(env: RuntimeEnvironment = process.env): BootstrapMode {
  return env[SMOKE_MODE_ENV] === 'true' ? 'read-only-smoke' : 'normal';
}

export function selectRootModule(mode: BootstrapMode, normalModule: Type<unknown>, smokeModule: Type<unknown>): Type<unknown> {
  return mode === 'read-only-smoke' ? smokeModule : normalModule;
}

export function getSmokeLoopbackHost(env: RuntimeEnvironment = process.env): string {
  const host = (env.HOST ?? '').trim().toLowerCase();
  const permittedHosts = new Set(['127.0.0.1', '::1', 'localhost']);

  if (!permittedHosts.has(host)) {
    throw new Error(
      'STARTUP ABORTED: SMOKE_MODE=true requires HOST to be one of 127.0.0.1, ::1, or localhost. ' +
      'Smoke mode must not accept network traffic.',
    );
  }

  return host;
}

export function getSmokeEnvFile(env: RuntimeEnvironment = process.env): string {
  const envFile = (env[SMOKE_ENV_FILE_ENV] ?? '').trim();
  if (!envFile.startsWith('/')) {
    throw new Error(
      'STARTUP ABORTED: SMOKE_MODE=true requires SMOKE_ENV_FILE to be an absolute path to the existing runtime configuration.',
    );
  }
  return envFile;
}
