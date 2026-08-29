import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseFlags, runWorkflowsCommand } from './workflows.js';

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

  it('posts the description and prints the created DRAFT + summary', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ body: JSON.parse(String(init.body)), url: String(url) });
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            attempts: 2,
            data: { activeVersion: 1, id: 'tpl-9', name: 'My Flow', status: 'DRAFT', team: null },
            summary: 'Runs the implementer then opens a PR.',
          }),
      } as unknown as Response;
    }) as typeof fetch;

    const code = await runWorkflowsCommand(['generate', 'build', 'me', 'a', 'flow'], ENV);

    expect(code).toBe(0);
    expect(calls[0].url).toBe('http://gw/api/v1/workflow-templates/generate');
    expect(calls[0].body).toMatchObject({ prompt: 'build me a flow', teamId: null });
    const out = stdoutWrites.join('');
    expect(out).toContain('Created DRAFT "My Flow"');
    expect(out).toContain('Runs the implementer then opens a PR.');
    expect(out).toContain('2 attempts');
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
