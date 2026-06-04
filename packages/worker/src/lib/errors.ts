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

/**
 * Joined stdout + stderr from an exec-like error, falling back to the error
 * message. Use when both streams carry signal (e.g. `git merge` reports the
 * conflicting files on stdout and the abort suggestion on stderr).
 */
export function getExecErrorOutput(err: unknown, maxBytes = 10_000): string {
  const e = err as ExecLikeError;
  const parts: string[] = [];
  if (typeof e.stdout === 'string') {
    parts.push(e.stdout);
  }
  if (typeof e.stderr === 'string') {
    parts.push(e.stderr);
  }
  if (parts.length === 0) {
    return getErrorMessage(err);
  }
  return parts.join('\n').slice(-maxBytes);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}
