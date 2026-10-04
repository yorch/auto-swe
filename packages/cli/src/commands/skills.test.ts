import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSkillsCommand } from './skills.js';

const ENV = { apiUrl: 'http://gw', token: 't' };
const SHA = 'a1b2c3d4e5f6'.padEnd(40, '0');

const skill = (name: string, over: Record<string, unknown> = {}) => ({
  blockedByScan: false,
  conflicts: [],
  errors: [],
  folder: `skills/${name}`,
  installable: true,
  name,
  referenceFileCount: 1,
  scanWarnings: [],
  skippedFiles: [],
  textLength: 120,
  ...over,
});

const PREVIEW = {
  location: { host: 'github.com', owner: 'acme', path: 'skills', ref: 'main', repo: 'pack' },
  sha: SHA,
  skills: [
    skill('good'),
    skill('flagged', { blockedByScan: true, installable: false, scanWarnings: ['injection:x'] }),
    skill('taken', { conflicts: [{ name: 'taken', scope: 'GLOBAL' }], installable: false }),
  ],
};

describe('skills sources', () => {
  let out: string[];
  let err: string[];
  let calls: Array<{ url: string; method: string; body: unknown }>;
  let originalErr: typeof process.stderr.write;
  let originalOut: typeof process.stdout.write;
  let originalFetch: typeof globalThis.fetch;

  const reply = (handler: (url: string, method: string) => { status?: number; body: unknown }) => {
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        method,
        url: String(url),
      });
      const r = handler(String(url), method);
      const status = r.status ?? 200;
      return { ok: status < 400, status, text: async () => JSON.stringify(r.body) } as Response;
    }) as typeof fetch;
  };

  beforeEach(() => {
    out = [];
    err = [];
    calls = [];
    originalErr = process.stderr.write;
    originalOut = process.stdout.write;
    originalFetch = globalThis.fetch;
    process.stderr.write = ((s: string | Uint8Array) => {
      err.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stderr.write = originalErr;
    process.stdout.write = originalOut;
    globalThis.fetch = originalFetch;
  });

  const addHandler = (url: string) =>
    url.endsWith('/preview')
      ? { body: { data: PREVIEW } }
      : { body: { data: { skills: [{ name: 'good' }], source: { id: 'src-1' } } }, status: 201 };

  it('list renders sources', async () => {
    reply(() => ({
      body: {
        data: [
          {
            host: 'github.com',
            id: 'id-1',
            lastError: 'timed out',
            owner: 'acme',
            path: 'skills',
            pinnedSha: SHA,
            ref: 'main',
            repo: 'pack',
            scope: 'GLOBAL',
            scriptMode: 'TEXT_ONLY',
            skillCount: 3,
            status: 'ERROR',
          },
        ],
      },
    }));
    expect(await runSkillsCommand(['sources', 'list'], ENV)).toBe(0);
    const text = out.join('');
    expect(text).toContain('acme/pack/skills');
    expect(text).toContain('a1b2c3d');
    expect(text).toContain('ERROR');
    expect(text).toContain('last error: timed out');
  });

  it('add previews, confirms, then creates with the previewed sha and only installable skills', async () => {
    reply(addHandler);
    const confirm = vi.fn(async () => true);
    const code = await runSkillsCommand(
      ['sources', 'add', 'acme/pack', '--ref=main', '--path=skills'],
      ENV,
      confirm
    );
    expect(code).toBe(0);
    expect(calls.map((c) => c.url)).toEqual([
      'http://gw/api/v1/platform/skill-sources/preview',
      'http://gw/api/v1/platform/skill-sources',
    ]);
    expect(calls[0]?.body).toEqual({
      host: 'github.com',
      owner: 'acme',
      path: 'skills',
      ref: 'main',
      repo: 'pack',
      scriptMode: 'TEXT_ONLY',
    });
    expect(calls[1]?.body).toMatchObject({ sha: SHA, skills: ['good'] });
    expect(confirm).toHaveBeenCalledOnce();
    const text = out.join('');
    expect(text).toContain('+ good');
    expect(text).toContain('- flagged');
    expect(text).toContain('scan: injection:x');
    expect(text).toContain('name already used by a GLOBAL skill');
    expect(text).toContain('Imported 1 skill(s)');
  });

  it('writes nothing when the confirmation is declined', async () => {
    reply(addHandler);
    const code = await runSkillsCommand(
      ['sources', 'add', 'acme/pack', '--ref=main'],
      ENV,
      async () => false
    );
    expect(code).toBe(1);
    expect(calls.map((c) => c.method + c.url.slice(-8))).toEqual(['POST/preview']);
    expect(err.join('')).toContain('nothing was imported');
  });

  it('--yes skips the prompt, --script-mode=reject is sent, --skills narrows the set', async () => {
    reply(addHandler);
    const confirm = vi.fn(async () => false);
    const code = await runSkillsCommand(
      ['sources', 'add', 'acme/pack', '--ref=v1', '--script-mode=reject', '--skills=good', '--yes'],
      ENV,
      confirm
    );
    expect(code).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(calls[0]?.body).toMatchObject({ ref: 'v1', scriptMode: 'REJECT' });
    expect(calls[1]?.body).toMatchObject({ skills: ['good'] });
  });

  it('refuses to import a skill the preview marked not installable', async () => {
    reply(addHandler);
    const code = await runSkillsCommand(
      ['sources', 'add', 'acme/pack', '--ref=main', '--skills=flagged', '--yes'],
      ENV
    );
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(err.join('')).toContain('flagged');
  });

  it('needs owner/repo and a ref, and a valid script mode', async () => {
    reply(addHandler);
    expect(await runSkillsCommand(['sources', 'add', 'acme', '--ref=main'], ENV)).toBe(1);
    expect(await runSkillsCommand(['sources', 'add', 'acme/pack'], ENV)).toBe(1);
    expect(
      await runSkillsCommand(
        ['sources', 'add', 'acme/pack', '--ref=main', '--script-mode=run'],
        ENV
      )
    ).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('reports a gateway refusal with its code and exit 2', async () => {
    reply(() => ({
      body: {
        error: { code: 'SKILL_SOURCE_NOT_FOUND', message: 'repository, ref or path not found' },
      },
      status: 404,
    }));
    expect(await runSkillsCommand(['sources', 'add', 'acme/pack', '--ref=main'], ENV)).toBe(2);
    expect(err.join('')).toContain('SKILL_SOURCE_NOT_FOUND');
  });

  it('rejects unknown subcommands', async () => {
    expect(await runSkillsCommand(['sources', 'frobnicate'], ENV)).toBe(1);
    expect(await runSkillsCommand(['nope'], ENV)).toBe(1);
    expect(await runSkillsCommand([], ENV)).toBe(0);
  });
});
