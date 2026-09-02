import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBundlesCommand } from './bundles.js';

const ENV = { apiUrl: 'http://gw', token: 't' };

describe('runBundlesCommand (gateway-backed)', () => {
  let stderrWrites: string[];
  let stdoutWrites: string[];
  let originalErr: typeof process.stderr.write;
  let originalOut: typeof process.stdout.write;
  let originalFetch: typeof globalThis.fetch;
  let dir: string;

  beforeEach(async () => {
    stderrWrites = [];
    stdoutWrites = [];
    originalErr = process.stderr.write;
    originalOut = process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    originalFetch = globalThis.fetch;
    dir = await fs.mkdtemp(path.join(tmpdir(), 'bundles-cli-'));
  });

  afterEach(async () => {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
    globalThis.fetch = originalFetch;
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('list renders installed bundles with trust state', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: [
                {
                  createdAt: '2026-01-01',
                  name: 'swe',
                  signedBy: 'acme',
                  source: 'swe-starter',
                  trustState: 'VERIFIED',
                  updatedAt: '2026-01-02',
                  version: '1.0.0',
                },
              ],
            }),
        }) as unknown as Response
    ) as typeof fetch;
    const code = await runBundlesCommand(['list'], ENV);
    expect(code).toBe(0);
    const out = stdoutWrites.join('');
    expect(out).toContain('swe');
    expect(out).toContain('VERIFIED');
  });

  it('install reads a local file, POSTs it, and prints counts', async () => {
    const file = path.join(dir, 'b.json');
    await fs.writeFile(file, JSON.stringify({ bundleSchemaVersion: 1 }));
    const captured: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      captured.push({ body: init?.body ? JSON.parse(init.body) : undefined, url });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              counts: { agents: 2, scannerPatterns: 0, skills: 1, templates: 1 },
              signedBy: null,
              trustState: 'UNVERIFIED',
              warnings: [],
            },
          }),
      } as unknown as Response;
    }) as typeof fetch;
    const code = await runBundlesCommand(['install', file], ENV);
    expect(code).toBe(0);
    expect(captured[0]?.url).toContain('/api/v1/platform/bundles/install');
    expect(captured[0]?.body).toEqual({ bundle: { bundleSchemaVersion: 1 } });
    expect(stdoutWrites.join('')).toContain('2 agents, 1 skills');
  });

  it('export requires both name and version', async () => {
    const code = await runBundlesCommand(['export', 'onlyname'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('Usage: bundles export');
  });

  it('maps a gateway 400 to exit code 2', async () => {
    const file = path.join(dir, 'b.json');
    await fs.writeFile(file, JSON.stringify({ bundleSchemaVersion: 1 }));
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 400,
          text: async () =>
            JSON.stringify({ error: { code: 'INVALID_BUNDLE', message: 'bad bundle' } }),
        }) as unknown as Response
    ) as typeof fetch;
    const code = await runBundlesCommand(['install', file], ENV);
    expect(code).toBe(2);
    expect(stderrWrites.join('')).toContain('INVALID_BUNDLE');
  });
});
