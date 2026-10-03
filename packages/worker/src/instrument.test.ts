/**
 * The service entry points are ESM, so every static import is evaluated before
 * the entry's own first statement: an SDK started there finds `http` already
 * bound and patches nothing. `src/instrument.ts` is therefore a `--import`
 * preload, and `initTelemetry` hands the instrumented modules to the
 * `import-in-the-middle` loader hook (`esmModules`), since the instrumentations'
 * own `require` hook never sees an ESM import.
 *
 * This runs the shared init path in a real child process — the only place the
 * module loader behaves as it does in production — and checks both halves.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const dir = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(dir, '__fixtures__/esmTelemetry');
const CLIENT = 2;
const SERVER = 1;

async function spanKinds(esmModules: string): Promise<number[]> {
  const { stdout } = await run(
    'npx',
    ['tsx', '--import', path.join(fixtures, 'preload.ts'), path.join(fixtures, 'app.ts')],
    {
      cwd: path.resolve(dir, '..'),
      env: {
        ...process.env,
        ESM_MODULES: esmModules,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1',
      },
      timeout: 60_000,
    }
  );
  const line = stdout.trim().split('\n').at(-1) ?? '{}';
  return (JSON.parse(line) as { kinds: number[] }).kinds;
}

describe('ESM instrumentation preload', () => {
  it('traces an ESM-imported http module once it is handed to the loader hook', async () => {
    const kinds = await spanKinds('http,https');
    expect(kinds).toContain(CLIENT);
    expect(kinds).toContain(SERVER);
  }, 90_000);

  it('traces nothing through the require hook alone, even from a preload', async () => {
    expect(await spanKinds('')).toEqual([]);
  }, 90_000);
});
