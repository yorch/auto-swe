export interface ExecLikeError {
  stdout?: string;
  stderr?: string;
  status?: number;
  message?: string;
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function getExecErrorStdout(err: unknown, maxBytes = 10_000): string {
  const e = err as ExecLikeError;
  return e.stdout?.slice(-maxBytes) ?? getErrorMessage(err);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}
