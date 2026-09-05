import { isAbsolute } from 'node:path';

export const RUNTIME_ENV_FILE_ENV = 'RUNTIME_ENV_FILE';

type RuntimeEnvironment = NodeJS.ProcessEnv;

/**
 * Optional process-wide environment file for an immutable release checkout.
 * The path is intentionally explicit and must be absolute, so a release can
 * consume its existing secure runtime configuration without copying secrets.
 */
export function getRuntimeEnvFile(env: RuntimeEnvironment = process.env): string | undefined {
  const envFile = (env[RUNTIME_ENV_FILE_ENV] ?? '').trim();
  if (!envFile) return undefined;
  if (!isAbsolute(envFile)) {
    throw new Error('STARTUP ABORTED: RUNTIME_ENV_FILE must be an absolute path when configured.');
  }
  return envFile;
}
