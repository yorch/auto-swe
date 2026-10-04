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

  it('prints server-supplied names without control characters (no terminal escapes)', async () => {
    const ESC = '\u001b[1A\u001b[2K\r';
    reply((url) =>
      url.endsWith('/preview')
        ? {
            body: {
              data: {
                ...PREVIEW,
                skills: [
                  skill(`n${ESC}ame`, {
                    errors: [`bad${ESC}`],
                    folder: `f${ESC}`,
                    ignoredKeys: [`k${ESC}`],
                    scanWarnings: [`w${ESC}`],
                    skippedFiles: [{ path: `a/${ESC}x.sh`, reason: 'not-text' }],
                  }),
                ],
              },
            },
          }
        : { body: { data: {} } }
    );
    await runSkillsCommand(['sources', 'add', 'acme/pack', '--ref=main'], ENV, async () => false);
    const text = out.join('');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting there are none
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(text).toContain('a/?[1A?[2K?x.sh');
    expect(text).toContain('ignored frontmatter: k?[1A?[2K?');
  });

  it('help says where the label appears and which credential is used', async () => {
    await runSkillsCommand([], ENV);
    const text = out.join('');
    expect(text).toContain('loadSkill');
    expect(text).toContain('300 API requests');
    expect(text).toContain("platform's GitHub credential");
  });

  it('rejects unknown subcommands', async () => {
    expect(await runSkillsCommand(['sources', 'frobnicate'], ENV)).toBe(1);
    expect(await runSkillsCommand(['nope'], ENV)).toBe(1);
    expect(await runSkillsCommand([], ENV)).toBe(0);
  });
  describe('tracked updates', () => {
    const NEW = 'b1c2d3e4f5a6'.padEnd(40, '0');
    const changed = (name: string, over: Record<string, unknown> = {}) => ({
      blockedByScan: false,
      description: { changed: false, new: 'd', old: 'd' },
      handEdited: false,
      installedRevision: 1,
      name,
      referenceFiles: { added: [], changed: [], removed: [] },
      scanWarnings: [],
      skippedFiles: [],
      textDiff: '@@ -1,1 +1,1 @@\n-old line\n+new line',
      textDiffTruncated: false,
      ...over,
    });
    const DIFF = {
      added: [{ errors: [], folder: 'skills/extra', name: 'extra', scanWarnings: [] }],
      changed: [changed('alpha'), changed('beta', { handEdited: true })],
      errors: [],
      removed: [{ folder: 'skills/gone', name: 'gone' }],
      sha: NEW,
      source: {
        id: 'src-1',
        lastError: null,
        latestSha: NEW,
        pinnedSha: SHA,
        status: 'UPDATE_AVAILABLE',
      },
      unchanged: [{ handEdited: false, name: 'gamma' }],
    };
    const ACCEPTED = {
      accepted: [{ fromRevision: 1, name: 'alpha', revision: 2 }],
      added: [],
      after: { pinnedSha: SHA, status: 'UPDATE_AVAILABLE' },
      conflicts: ['beta'],
      notSelected: [],
      pinAdvanced: false,
      removed: [],
      sha: NEW,
      unreadable: [],
    };
    const updateHandler = (url: string) =>
      url.includes('/diff')
        ? { body: { data: DIFF } }
        : url.endsWith('/check')
          ? { body: { data: DIFF.source } }
          : { body: { data: ACCEPTED } };

    it('check asks the host through the API and prints the status', async () => {
      reply(updateHandler);
      expect(await runSkillsCommand(['sources', 'check', 'src-1'], ENV)).toBe(0);
      expect(calls[0]).toMatchObject({
        method: 'POST',
        url: 'http://gw/api/v1/platform/skill-sources/src-1/check',
      });
      expect(out.join('')).toContain('UPDATE_AVAILABLE (pinned a1b2c3d, latest b1c2d3e)');
    });

    it('diff prints each category and the text diff, and sends --sha', async () => {
      reply(updateHandler);
      expect(await runSkillsCommand(['sources', 'diff', 'src-1', `--sha=${NEW}`], ENV)).toBe(0);
      expect(calls[0]?.url).toContain(`/src-1/diff?sha=${NEW}`);
      const text = out.join('');
      expect(text).toContain('2 changed, 1 unchanged, 1 not installed, 1 removed');
      expect(text).toContain('~ alpha');
      expect(text).toContain('conflict: edited by hand');
      expect(text).toContain('-old line');
      expect(text).toContain('+ extra  not installed (accept does not install it)');
      expect(text).toContain('- gone  no longer in the source; left installed');
    });

    it('accept shows the diff, confirms, then accepts the diffed sha without the hand-edited skill', async () => {
      reply(updateHandler);
      const asked: string[] = [];
      const code = await runSkillsCommand(['sources', 'accept', 'src-1'], ENV, async (q) => {
        asked.push(q);
        return true;
      });
      expect(code).toBe(0);
      expect(asked[0]).toContain('Update 1 skill(s) (alpha)');
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).toEqual({ sha: NEW });
      expect(err.join('')).toContain('Left alone (edited by hand): beta');
      const text = out.join('');
      expect(text).toContain('Updated alpha: revision 1 → 2 (unverified)');
      expect(text).toContain('Source stays at a1b2c3d (UPDATE_AVAILABLE)');
    });

    it('accept writes nothing when the confirmation is declined', async () => {
      reply(updateHandler);
      expect(await runSkillsCommand(['sources', 'accept', 'src-1'], ENV, async () => false)).toBe(
        1
      );
      expect(calls.some((c) => c.method === 'POST')).toBe(false);
      expect(err.join('')).toContain('nothing was changed');
    });

    it('accept --skills names a hand-edited skill to overwrite it, and --yes skips the prompt', async () => {
      reply(updateHandler);
      const confirm = vi.fn(async () => false);
      expect(
        await runSkillsCommand(
          ['sources', 'accept', 'src-1', '--skills=alpha,beta', '--yes'],
          ENV,
          confirm
        )
      ).toBe(0);
      expect(confirm).not.toHaveBeenCalled();
      expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
        sha: NEW,
        skills: ['alpha', 'beta'],
      });
    });

    it('needs an id, and --sha needs a value', async () => {
      expect(await runSkillsCommand(['sources', 'check'], ENV)).toBe(1);
      expect(await runSkillsCommand(['sources', 'diff'], ENV)).toBe(1);
      expect(await runSkillsCommand(['sources', 'diff', 'src-1', '--sha'], ENV)).toBe(1);
      expect(await runSkillsCommand(['sources', 'accept'], ENV)).toBe(1);
      expect(calls).toHaveLength(0);
    });

    it('reports a stale-sha refusal with its code and exit 2', async () => {
      reply((url, method) =>
        method === 'POST'
          ? {
              body: {
                error: { code: 'SKILL_UPDATE_STALE_SHA', message: 'different latest commit' },
              },
              status: 409,
            }
          : updateHandler(url)
      );
      expect(await runSkillsCommand(['sources', 'accept', 'src-1', '--yes'], ENV)).toBe(2);
      expect(err.join('')).toContain('SKILL_UPDATE_STALE_SHA');
    });

    it('prints server-supplied names, descriptions and diff lines without control characters', async () => {
      const ESC = '\u001b[1A\u001b[2K\r';
      reply(() => ({
        body: {
          data: {
            ...DIFF,
            changed: [
              changed(`n${ESC}ame`, {
                description: { changed: true, new: `d${ESC}`, old: `o${ESC}` },
                referenceFiles: { added: [`r${ESC}.md`], changed: [], removed: [] },
                scanWarnings: [`w${ESC}`],
                textDiff: `-a${ESC}\n+b${ESC}`,
              }),
            ],
            removed: [{ folder: 'x', name: `gone${ESC}` }],
          },
        },
      }));
      await runSkillsCommand(['sources', 'diff', 'src-1'], ENV);
      const text = out.join('');
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting there are none
      expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      expect(text).toContain('-a?[1A?[2K?');
      expect(text).toContain('+b?[1A?[2K?');
    });

    it('help documents the three commands', async () => {
      await runSkillsCommand([], ENV);
      const text = out.join('');
      expect(text).toContain('skills sources check <id>');
      expect(text).toContain('skills sources diff <id>');
      expect(text).toContain('skills sources accept <id>');
    });
  });
});
