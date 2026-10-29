import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface McpCredentials {
  issuer: string;
  clientId: string;
  resource: string;
  scopes: string[];
  accessToken?: string;
  accessTokenExpiresAt?: number;
  refreshToken?: string;
}

type Credentials = Record<string, McpCredentials>;

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function validEntry(value: unknown): value is McpCredentials {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    ['issuer', 'clientId', 'resource'].every((key) => typeof row[key] === 'string') &&
    Array.isArray(row.scopes) &&
    row.scopes.every((scope) => typeof scope === 'string') &&
    ['accessToken', 'refreshToken'].every(
      (key) => row[key] === undefined || typeof row[key] === 'string'
    ) &&
    (row.accessTokenExpiresAt === undefined ||
      (typeof row.accessTokenExpiresAt === 'number' && Number.isFinite(row.accessTokenExpiresAt)))
  );
}

/** Serialize read/refresh/write as well as atomic replacement: refresh tokens rotate on use. */
export async function withMcpCredentials<T>(
  work: (entries: Credentials) => Promise<T>
): Promise<T> {
  const xdg = process.env.XDG_CONFIG_HOME;
  const directory = join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'), 'auto-swe');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink()) {
    throw new Error('MCP config directory must be a real directory.');
  }
  await chmod(directory, 0o700);
  const lock = join(directory, '.mcp-credentials.lock');
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error('MCP credentials are busy. Retry after the other MCP command finishes.');
      }
      await delay(50);
    }
  }
  const file = join(directory, 'mcp-credentials.json');
  const temporary = join(directory, `.mcp-credentials-${randomUUID()}.json`);
  try {
    let entries: Credentials = Object.create(null);
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('MCP credentials must be a regular file.');
      }
      await chmod(file, 0o600);
      const contents = await readFile(file, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch {
        throw new Error('MCP credentials file is invalid.');
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !Object.values(parsed).every(validEntry)
      ) {
        throw new Error('MCP credentials file is invalid.');
      }
      entries = Object.assign(Object.create(null), parsed);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        throw error;
      }
    }
    const result = await work(entries);
    const output = await open(temporary, 'wx', 0o600);
    try {
      await output.chmod(0o600);
      await output.writeFile(`${JSON.stringify(entries, null, 2)}\n`);
      await output.sync();
    } finally {
      await output.close();
    }
    await rename(temporary, file);
    return result;
  } finally {
    try {
      await unlink(temporary).catch((error: unknown) => {
        if (!hasCode(error, 'ENOENT')) {
          throw error;
        }
      });
    } finally {
      await rmdir(lock);
    }
  }
}
