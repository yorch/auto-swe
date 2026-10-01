import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgentCommand } from './agent.js';

const ENV = { apiUrl: 'http://gw', token: 't' };
const REPO_ID = '550e8400-e29b-41d4-a716-446655440000';
const WR = '660e8400-e29b-41d4-a716-446655440000';

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

describe('auto-swe agent', () => {
  let out: string[];
  let err: string[];
  let calls: Call[];
  let originalOut: typeof process.stdout.write;
  let originalErr: typeof process.stderr.write;
  let originalFetch: typeof globalThis.fetch;
  let responder: (c: Call) => { status?: number; body: unknown };

  beforeEach(() => {
    out = [];
    err = [];
    calls = [];
    originalOut = process.stdout.write;
    originalErr = process.stderr.write;
    originalFetch = globalThis.fetch;
    process.stdout.write = ((s: string | Uint8Array) => {
      out.push(String(s));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((s: string | Uint8Array) => {
      err.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    responder = () => ({
      body: {
        data: {
          effective: { deliver: 'none', maxSteps: 50, maxWallClockSeconds: 1800 },
          temporalWorkflowId: 'agent-x',
          workflowId: 'aw-1',
          workRequestId: WR,
        },
      },
      status: 201,
    });
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const call: Call = {
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
        method: String(init?.method),
        url: String(url),
      };
      calls.push(call);
      const r = responder(call);
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    globalThis.fetch = originalFetch;
  });

  it('prints help', async () => {
    expect(await runAgentCommand(['--help'], ENV)).toBe(0);
    expect(out.join('')).toContain('agent run');
  });

  it('launches with the positional prompt and a repo id, defaulting to deliver none', async () => {
    const code = await runAgentCommand(
      ['run', 'contentWriter@2', 'fix the typo', `--repo-id=${REPO_ID}`],
      ENV
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      body: {
        agent: 'contentWriter@2',
        budgetTier: 'STANDARD',
        deliver: 'none',
        prompt: 'fix the typo',
        repoId: REPO_ID,
      },
      method: 'POST',
      url: 'http://gw/api/v1/agent-runs',
    });
    expect(calls[0]?.body).not.toHaveProperty('maxSteps');
    expect(out.join('')).toContain(WR);
  });

  it('sends the caps, delivery and idempotency key', async () => {
    await runAgentCommand(
      [
        'run',
        'a',
        'p',
        `--repo=${REPO_ID}`,
        '--deliver=draft_pr',
        '--max-steps=10',
        '--timeout=120',
        '--budget=large',
        '--idempotency-key=abc',
      ],
      ENV
    );
    expect(calls[0]?.body).toMatchObject({
      budgetTier: 'LARGE',
      deliver: 'draft_pr',
      maxSteps: 10,
      maxWallClockSeconds: 120,
    });
    expect(calls[0]?.headers['Idempotency-Key']).toBe('abc');
  });

  it('reads the prompt from a file, for a long prompt or one starting with a dash', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-cli-'));
    const file = path.join(dir, 'p.txt');
    await writeFile(file, '-- a prompt that starts with dashes\nand has two lines\n');
    await runAgentCommand(['run', 'a', `--prompt=@${file}`, `--repo-id=${REPO_ID}`], ENV);
    expect(calls[0]?.body?.prompt).toBe('-- a prompt that starts with dashes\nand has two lines');
  });

  it('does not let --wait swallow the agent key', async () => {
    responder = (c) =>
      c.method === 'POST'
        ? {
            body: {
              data: {
                effective: { deliver: 'none', maxSteps: 1, maxWallClockSeconds: 60 },
                temporalWorkflowId: 't',
                workflowId: 'aw',
                workRequestId: WR,
              },
            },
            status: 201,
          }
        : c.url.includes('/workflow-runs?')
          ? { body: { data: [{ id: 'run-1' }] } }
          : { body: { data: { result: { text: 'hi' }, status: 'SUCCESS', steps: [] } } };
    const code = await runAgentCommand(
      ['run', '--wait', 'contentWriter', 'p', `--repo-id=${REPO_ID}`],
      ENV
    );
    expect(code).toBe(0);
    expect(calls[0]?.body?.agent).toBe('contentWriter');
  });

  it.each([
    [['run'], 'Usage'],
    [['run', 'a'], 'Missing prompt'],
    [['run', 'a', 'p'], '--repo'],
    [['run', 'a', 'p', `--repo-id=${REPO_ID}`, '--deliver=push'], '--deliver'],
    [['run', 'a', 'p', `--repo-id=${REPO_ID}`, '--max-steps=0x'], '--max-steps'],
    [['run', 'a', 'p', `--repo-id=${REPO_ID}`, '--budget=HUGE'], '--budget'],
    [['run', 'a', 'p', '--repo-id=nope'], '--repo-id'],
    [['run', 'a', 'p', '--repo=a', '--repo-id=b'], 'mutually exclusive'],
    [['frobnicate'], 'Unknown subcommand'],
  ])('rejects %j locally with exit 1 and no request', async (args, message) => {
    expect(await runAgentCommand(args, ENV)).toBe(1);
    expect(err.join('')).toContain(message);
    expect(calls).toHaveLength(0);
  });

  it('exits 2 on a gateway refusal and prints the code', async () => {
    responder = () => ({
      body: { error: { code: 'CAP_EXCEEDS_CEILING', message: 'maxSteps 99 is above 50' } },
      status: 400,
    });
    expect(await runAgentCommand(['run', 'a', 'p', `--repo-id=${REPO_ID}`], ENV)).toBe(2);
    expect(err.join('')).toContain('CAP_EXCEEDS_CEILING');
  });

  describe('--wait', () => {
    function pollingResponder(final: { status: string; result?: unknown; steps?: unknown[] }) {
      return (c: Call) => {
        if (c.method === 'POST') {
          return {
            body: {
              data: {
                effective: { deliver: 'branch', maxSteps: 5, maxWallClockSeconds: 60 },
                temporalWorkflowId: 't',
                workflowId: 'aw',
                workRequestId: WR,
              },
            },
            status: 201,
          };
        }
        if (c.url.includes('/workflow-runs?')) {
          return { body: { data: [{ id: 'run-1' }] } };
        }
        return { body: { data: { steps: [], ...final } } };
      };
    }

    it('exits 0 and prints the outcome for a successful delivered run', async () => {
      responder = pollingResponder({
        result: {
          branch: 'auto/agent-0a1b2c3d',
          filesChanged: [{ linesAdded: 3, linesRemoved: 1, operation: 'MODIFY', path: 'a.ts' }],
          gate: 'passed',
          headSha: 'f'.repeat(40),
          prUrl: 'https://x/pull/7',
          text: 'Done.',
        },
        status: 'SUCCESS',
      });
      const code = await runAgentCommand(
        ['run', 'a', 'p', `--repo-id=${REPO_ID}`, '--deliver=draft_pr', '--wait'],
        ENV
      );
      expect(code).toBe(0);
      const text = out.join('');
      expect(text).toContain('Done.');
      expect(text).toContain('auto/agent-0a1b2c3d');
      expect(text).toContain('https://x/pull/7');
      expect(text).toContain('a.ts');
      // The run was looked up by its work request.
      expect(calls.some((c) => c.url.includes(`workRequestId=${WR}`))).toBe(true);
    });

    it('exits 2 and prints the failing step message when the run fails', async () => {
      responder = pollingResponder({
        status: 'FAILED',
        steps: [
          { error: 'Security scan failed with critical findings:\n[CRITICAL] x', nodeId: 'run' },
        ],
      });
      const code = await runAgentCommand(['run', 'a', 'p', `--repo-id=${REPO_ID}`, '--wait'], ENV);
      expect(code).toBe(2);
      expect(err.join('')).toContain('Security scan failed');
    });

    it('labels a diff from a deliver-none run as unverified', async () => {
      responder = pollingResponder({
        result: { deliver: 'none', diff: 'diff --git a/x b/x', text: 'ok' },
        status: 'SUCCESS',
      });
      await runAgentCommand(['run', 'a', 'p', `--repo-id=${REPO_ID}`, '--wait'], ENV);
      expect(out.join('')).toContain('not verified');
    });
  });

  it('re-runs by work request id', async () => {
    const code = await runAgentCommand(['rerun', WR, '--idempotency-key=k'], ENV);
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `http://gw/api/v1/agent-runs/${WR}/rerun`,
    });
    expect(calls[0]?.headers['Idempotency-Key']).toBe('k');
    expect(await runAgentCommand(['rerun', 'not-a-uuid'], ENV)).toBe(1);
  });
});
