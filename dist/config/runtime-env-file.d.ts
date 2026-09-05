export declare const RUNTIME_ENV_FILE_ENV = "RUNTIME_ENV_FILE";
type RuntimeEnvironment = NodeJS.ProcessEnv;
export declare function getRuntimeEnvFile(env?: RuntimeEnvironment): string | undefined;
export {};
