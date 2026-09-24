import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFlags } from '../lib/flags.js';
import { findTemplateByName, GENERATE_POLL_MS, runWorkflowsCommand } from './workflows.js';

const ENV = { apiUrl: 'http://gw', token: 't' };

describe('parseFlags', () => {
  it('returns positional args only when no flags are present', () => {
    expect(parseFlags(['a', 'b'])).toEqual({ flags: {}, positional: ['a', 'b'] });
  });

  it('supports --foo=bar inline form', () => {
    expect(parseFlags(['--name=my-template'])).toEqual({
      flags: { name: 'my-template' },
      positional: [],
    });
  });

  it('supports --foo bar space-separated form', () => {
    expect(parseFlags(['--name', 'my-template', 'extra'])).toEqual({
      flags: { name: 'my-template' },
      positional: ['extra'],
    });
  });

  it('supports short -o flag for output paths', () => {
    expect(parseFlags(['workflow-name', '-o', 'out.json'])).toEqual({
      flags: { o: 'out.json' },
      positional: ['workflow-name'],
    });
  });

  it('treats flag without value as boolean "true"', () => {
    expect(parseFlags(['--dry-run'])).toEqual({
      flags: { 'dry-run': 'true' },
      positional: [],
    });
  });

  it('does not consume a following flag as a value for the prior flag', () => {
    expect(parseFlags(['--a', '--b=2'])).toEqual({
      flags: { a: 'true', b: '2' },
      positional: [],
    });
  });

  it('mixes positionals + flags in any order', () => {
    expect(parseFlags(['list', '--team=payments', 'unused'])).toEqual({
      flags: { team: 'payments' },
      positional: ['list', 'unused'],
    });
  });
});

describe('runWorkflowsCommand flag validation', () => {
  let stderrWrites: string[];
  let originalWrite: typeof process.stderr.write;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    stderrWrites = [];
    originalWrite = process.stderr.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    originalFetch = globalThis.fetch;
    // Default fetch never invoked — these tests should reject before hitting the API.
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called when flags are invalid');
    }) as typeof fetch;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    globalThis.fetch = originalFetch;
  });

  it('rejects --version without a value', async () => {
    // parseFlags assigns 'true' when a flag has no following value
    const code = await runWorkflowsCommand(['show', 'name', '--version'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('rejects --version with a non-numeric value', async () => {
    const code = await runWorkflowsCommand(['show', 'name', '--version=abc'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('rejects --version=0', async () => {
    const code = await runWorkflowsCommand(['show', 'name', '--version=0'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('positive integer');
  });

  it('rejects -o without a value to avoid writing to a file named "true"', async () => {
    const code = await runWorkflowsCommand(['export', 'name', '-o'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('requires a file path');
  });

  it('rejects generate --team with no value instead of using "true" as the slug', async () => {
    const code = await runWorkflowsCommand(['generate', 'do a thing', '--team'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('--team requires a value');
  });

  it('rejects generate with no description', async () => {
    const code = await runWorkflowsCommand(['generate'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('workflows generate');
  });
});

describe('runWorkflowsCommand generate', () => {
  let stdoutWrites: string[];
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    stdoutWrites = [];
    originalStdout = process.stdout.write;
    originalStderr = process.stderr.write;
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    globalThis.fetch = originalFetch;
  });

  it('starts an async generation job, polls it, and prints the created DRAFT + summary', async () => {
    vi.useFakeTimers();
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let polls = 0;
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        method: init.method ?? 'GET',
        url: String(url),
      });
      const body =
        init.method === 'POST'
          ? { data: { jobId: 'wfauthorjob-1' } }
          : polls++ === 0
            ? { data: { phase: 'generating', status: 'running' } }
            : {
                data: {
                  attempts: 2,
                  name: 'My Flow',
                  status: 'done',
                  summary: 'Runs the implementer then opens a PR.',
                  templateId: 'tpl-9',
                },
              };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
    }) as unknown as typeof fetch;

    const pending = runWorkflowsCommand(['generate', 'build', 'me', 'a', 'flow'], ENV);
    await vi.advanceTimersByTimeAsync(GENERATE_POLL_MS);
    const code = await pending;
    vi.useRealTimers();

    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({
      body: { prompt: 'build me a flow', teamId: null },
      method: 'POST',
      url: 'http://gw/api/v1/workflow-templates/generate/jobs',
    });
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      'http://gw/api/v1/workflow-templates/generate/jobs/wfauthorjob-1',
      'http://gw/api/v1/workflow-templates/generate/jobs/wfauthorjob-1',
    ]);
    const out = stdoutWrites.join('');
    expect(out).toContain('Created DRAFT "My Flow" (id tpl-9)');
    expect(out).toContain('Runs the implementer then opens a PR.');
    expect(out).toContain('2 attempts');
  });

  it('exits 2 with the job error when generation fails', async () => {
    globalThis.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body =
        init.method === 'POST'
          ? { data: { jobId: 'wfauthorjob-2' } }
          : { data: { code: 'GENERATION_FAILED', message: 'no valid spec', status: 'failed' } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
    }) as unknown as typeof fetch;
    const code = await runWorkflowsCommand(['generate', 'x'], ENV);
    expect(code).toBe(2);
  });
});

describe('findTemplateByName scoping', () => {
  let originalFetch: typeof globalThis.fetch;
  const rows = [
    { activeVersion: 1, id: 'tpl-g', name: 'Deploy', status: 'ACTIVE', team: null },
    {
      activeVersion: 1,
      id: 'tpl-p',
      name: 'Deploy',
      status: 'ACTIVE',
      team: { id: 't-p', name: 'Payments', slug: 'payments' },
    },
    {
      activeVersion: 1,
      id: 'tpl-o',
      name: 'Only',
      status: 'ACTIVE',
      team: { id: 't-p', name: 'Payments', slug: 'payments' },
    },
  ];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: rows }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws on a name that exists in more than one scope', async () => {
    await expect(findTemplateByName(ENV, 'Deploy')).rejects.toThrow(
      /matches 2 templates \(global, team payments\).*--team/
    );
  });

  it('picks the team template with a team scope and the global one with --global', async () => {
    expect((await findTemplateByName(ENV, 'Deploy', { kind: 'team', slug: 'payments' }))?.id).toBe(
      'tpl-p'
    );
    expect((await findTemplateByName(ENV, 'Deploy', { kind: 'global' }))?.id).toBe('tpl-g');
  });

  it('still resolves an unambiguous name without a scope, and never across teams', async () => {
    expect((await findTemplateByName(ENV, 'Only'))?.id).toBe('tpl-o');
    expect(await findTemplateByName(ENV, 'Only', { kind: 'team', slug: 'other' })).toBeNull();
    expect(await findTemplateByName(ENV, 'Only', { kind: 'global' })).toBeNull();
  });
});

describe('runWorkflowsCommand import scoping', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;
  let stderrWrites: string[];
  let dir: string;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalStdout = process.stdout.write;
    originalStderr = process.stderr.write;
    stderrWrites = [];
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    dir = await mkdtemp(join(tmpdir(), 'cli-import-'));
    await writeFile(join(dir, 'Deploy.json'), '{"nodes":[]}');
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    await rm(dir, { force: true, recursive: true });
  });

  function fetchWith(rows: unknown[], calls: string[]) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === 'http://gw/api/v1/workflow-templates' && (init?.method ?? 'GET') === 'GET') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: rows }) };
      }
      if (url === 'http://gw/api/v1/teams') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ data: [{ id: 't-o', slug: 'ops' }] }),
        };
      }
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({ data: { activeVersion: 1, id: 'new', name: 'Deploy', version: 2 } }),
      };
    }) as unknown as typeof fetch;
  }

  it("creates a new template in --team instead of versioning another team's same-named one", async () => {
    const calls: string[] = [];
    globalThis.fetch = fetchWith(
      [
        {
          activeVersion: 1,
          id: 'tpl-p',
          name: 'Deploy',
          status: 'ACTIVE',
          team: { id: 't-p', name: 'Payments', slug: 'payments' },
        },
      ],
      calls
    );
    const code = await runWorkflowsCommand(['import', join(dir, 'Deploy.json'), '--team=ops'], ENV);
    expect(code).toBe(0);
    expect(calls).toContain('POST http://gw/api/v1/workflow-templates');
    expect(calls.some((c) => c.includes('/tpl-p/versions'))).toBe(false);
  });

  it('refuses an ambiguous name without --team', async () => {
    const calls: string[] = [];
    globalThis.fetch = fetchWith(
      [
        { activeVersion: 1, id: 'tpl-g', name: 'Deploy', status: 'ACTIVE', team: null },
        {
          activeVersion: 1,
          id: 'tpl-p',
          name: 'Deploy',
          status: 'ACTIVE',
          team: { id: 't-p', name: 'Payments', slug: 'payments' },
        },
      ],
      calls
    );
    const code = await runWorkflowsCommand(['import', join(dir, 'Deploy.json')], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('matches 2 templates');
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
  });
});

describe('runWorkflowsCommand run', () => {
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let originalStdout: typeof process.stdout.write;
  let originalStderr: typeof process.stderr.write;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    originalStdout = process.stdout.write;
    originalStderr = process.stderr.write;
    process.stdout.write = ((s: string | Uint8Array) => {
      stdoutWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      stderrWrites.push(typeof s === 'string' ? s : Buffer.from(s).toString());
      return true;
    }) as typeof process.stderr.write;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    globalThis.fetch = originalFetch;
  });

  it('requires a template name', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called without a template name');
    }) as typeof fetch;
    const code = await runWorkflowsCommand(['run'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('workflows run <name>');
  });

  it('rejects --payload that is not valid JSON', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url === 'http://gw/api/v1/workflow-templates') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: [{ activeVersion: 1, id: 'tpl-9', name: 'My Flow', status: 'ACTIVE' }],
            }),
        } as unknown as Response;
      }
      throw new Error('fetch should not be called after invalid JSON');
    }) as typeof fetch;
    const code = await runWorkflowsCommand(['run', 'My Flow', '--payload=not-json'], ENV);
    expect(code).toBe(1);
    expect(stderrWrites.join('')).toContain('not valid JSON');
  });

  it('posts to the runs endpoint and prints the run ids', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (url === 'http://gw/api/v1/workflow-templates') {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              data: [{ activeVersion: 1, id: 'tpl-9', name: 'My Flow', status: 'ACTIVE' }],
            }),
        } as unknown as Response;
      }
      calls.push({ body: JSON.parse(String(init.body)), url: String(url) });
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            data: {
              temporalWorkflowId: 'twf-1',
              workflowId: 'wf-1',
              workRequestId: 'wr-1',
            },
          }),
      } as unknown as Response;
    }) as typeof fetch;

    const code = await runWorkflowsCommand(
      ['run', 'My Flow', '--payload={"ticketId":"WEB-1"}', '--label=prod'],
      ENV
    );

    expect(code).toBe(0);
    expect(calls[0].url).toBe('http://gw/api/v1/workflow-templates/tpl-9/runs');
    expect(calls[0].body).toEqual({ label: 'prod', payload: { ticketId: 'WEB-1' } });
    expect(stdoutWrites.join('')).toContain('workRequestId=wr-1');
  });
});
