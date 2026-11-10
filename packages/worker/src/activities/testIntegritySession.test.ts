/**
 * The test-integrity commit against real git, no mocks: a throwaway repository plays the
 * workspace, and each way the review found to hide or change a fix after the gate looked at it is
 * carried out for real.
 */
import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApplicationFailure } from '@temporalio/activity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTracer } from '../lib/agentTracer.js';
import {
  commitWithTestIntegrity,
  startTestIntegritySession,
  type TestIntegritySession,
} from './testIntegritySession.js';

let dir: string;
const sh = (cmd: string): string =>
  execSync(cmd, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    maxBuffer: 64 * 1024 * 1024,
    shell: '/bin/sh',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const workspace = { exec: async (cmd: string) => sh(cmd) };
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
const TEST = [
  "import { add } from './a';",
  "it('adds', () => {",
  '  expect(add(1, 2)).toBe(3);',
  '});',
  "it('adds negatives', () => {",
  '  expect(add(-1, -2)).toBe(-3);',
  '});',
  '',
].join('\n');

function tracer() {
  const addActivityEvent = vi.fn();
  return { addActivityEvent, tracer: { addActivityEvent } as unknown as AgentTracer };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'test-integrity-'));
  sh('git init -q -b main && git config user.name t && git config user.email t@t');
  write('src/a.ts', 'export const add = (a: number, b: number) => a - b;\n');
  write('src/a.test.ts', TEST);
  write('yarn.lock', '# lock\n');
  sh('git add -A && git commit -q -m base');
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

async function start(mode: 'warn' | 'block', t = tracer()): Promise<TestIntegritySession> {
  const session = await startTestIntegritySession(workspace, mode, t.tracer);
  expect(session).toBeDefined();
  return session as TestIntegritySession;
}

async function failureOf(p: Promise<unknown>): Promise<ApplicationFailure> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApplicationFailure) {
      return err;
    }
    throw err;
  }
  throw new Error('expected the commit to be refused');
}

const headFiles = () => sh('git ls-tree -r --name-only HEAD').trim().split('\n');

describe('commitWithTestIntegrity', () => {
  it('commits an honest fix and returns the sha that was analysed', async () => {
    const t = tracer();
    const session = await start('block', t);
    write('src/a.ts', 'export const add = (a: number, b: number) => a + b;\n');
    sh('git add -A');
    const sha = await commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer);
    expect(sha).toBe(sh('git rev-parse HEAD').trim());
    expect(t.addActivityEvent).not.toHaveBeenCalled();
  });

  it('B1: a pre-commit hook set through core.hooksPath cannot remove a test after the gate', async () => {
    const t = tracer();
    const session = await start('block', t);
    // The agent plants a hook that drops the test from the commit, and points git at it. With no
    // path guard (the ciLoop fix node sets none) the old plain `git commit` ran it.
    write('.git/evil/pre-commit', '#!/bin/sh\ngit rm -q --cached src/a.test.ts\n');
    chmodSync(path.join(dir, '.git/evil/pre-commit'), 0o755);
    sh('git config core.hooksPath .git/evil');
    write('src/a.ts', 'export const add = (a: number, b: number) => a + b;\n');
    sh('git add -A');
    const sha = await commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer);
    expect(sha).toBeDefined();
    expect(headFiles()).toContain('src/a.test.ts');
  });

  it('B1: what is analysed is the committed result, not the index', async () => {
    const t = tracer();
    const session = await start('block', t);
    // The agent commits the deletion itself and leaves nothing staged.
    sh('git rm -q src/a.test.ts && git commit -q -m "agent: drop the failing test"');
    sh('git add -A');
    const failure = await failureOf(
      commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer)
    );
    expect(failure.type).toBe('TEST_INTEGRITY_GUARD');
    expect(failure.nonRetryable).toBe(true);
  });

  it('a block returns no sha, so nothing can be pushed', async () => {
    const t = tracer();
    const session = await start('block', t);
    sh('git rm -q src/a.test.ts');
    let sha: string | undefined;
    await failureOf(
      (async () => {
        sha = await commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer);
      })()
    );
    expect(sha).toBeUndefined();
  });

  it('warn mode records the trip and returns the sha', async () => {
    const t = tracer();
    const session = await start('warn', t);
    sh('git rm -q src/a.test.ts');
    const sha = await commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer);
    expect(sha).toBeDefined();
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outputJson: expect.objectContaining({ blocked: false, mode: 'warn' }),
      })
    );
  });

  it('B2: -diff in .git/info/attributes does not blind the diff', async () => {
    const t = tracer();
    const session = await start('block', t);
    write('.git/info/attributes', '*.ts -diff\n');
    sh('git rm -q src/a.test.ts');
    const failure = await failureOf(
      commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer)
    );
    expect(failure.type).toBe('TEST_INTEGRITY_GUARD');
  });

  it('B2: a binary attribute in .gitattributes does not blind the diff, and the change is flagged', async () => {
    const t = tracer();
    const session = await start('block', t);
    write('.gitattributes', '* binary\n');
    write('src/a.test.ts', "it.skip('adds', () => {});\n");
    sh('git add -A');
    const failure = await failureOf(
      commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer)
    );
    const details = failure.details?.[0] as { findings: Array<{ kind: string }> };
    const kinds = details.findings.map((f) => f.kind);
    expect(kinds).toContain('gitattributes_changed');
    expect(kinds).toContain('test_case_removed');
  });

  it('B2: diff.mnemonicPrefix and diff.noprefix do not change the path prefixes it reads', async () => {
    const t = tracer();
    const session = await start('block', t);
    sh('git config diff.mnemonicPrefix true && git config diff.noprefix true');
    sh('git rm -q src/a.test.ts');
    const failure = await failureOf(
      commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer)
    );
    expect(failure.type).toBe('TEST_INTEGRITY_GUARD');
  });

  it('M4: a regenerated lockfile of several MB does not make the diff unreadable', async () => {
    const t = tracer();
    const session = await start('block', t);
    const lines = Array.from(
      { length: 150_000 },
      (_, i) => `  resolution: "pkg-${i}@npm:1.0.${i}"`
    );
    write('yarn.lock', `${lines.join('\n')}\n`);
    write('src/a.ts', 'export const add = (a: number, b: number) => a + b;\n');
    sh('git add -A');
    const sha = await commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer);
    expect(sha).toBeDefined();
    expect(t.addActivityEvent).not.toHaveBeenCalled();
  });

  it('M4: a diff over the cap records a degraded event and still sees a deleted test', async () => {
    const t = tracer();
    const session = await start('block', t);
    const lines = Array.from({ length: 150_000 }, (_, i) => `export const v${i} = ${i};`);
    write('src/big.ts', `${lines.join('\n')}\n`);
    sh('git rm -q src/a.test.ts');
    sh('git add -A');
    const failure = await failureOf(
      commitWithTestIntegrity(workspace, 'auto: fix', undefined, session, t.tracer)
    );
    expect(failure.type).toBe('TEST_INTEGRITY_GUARD');
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outputJson: expect.objectContaining({ degraded: true, truncatedDiff: true }),
      })
    );
  });

  it('without a session it is the original commit', async () => {
    const t = tracer();
    write('src/a.ts', 'export const add = 1;\n');
    sh('git add -A');
    await expect(
      commitWithTestIntegrity(workspace, 'auto: fix', undefined, undefined, t.tracer)
    ).resolves.toBeUndefined();
    expect(sh('git log --format=%s -1').trim()).toBe('auto: fix');
  });
});

describe('startTestIntegritySession', () => {
  it('is nothing when off', async () => {
    const t = tracer();
    await expect(startTestIntegritySession(workspace, 'off', t.tracer)).resolves.toBeUndefined();
  });

  it('fails closed in block mode when the starting commit cannot be read', async () => {
    const t = tracer();
    const broken = {
      exec: async () => {
        throw new Error('no git');
      },
    };
    const failure = await failureOf(startTestIntegritySession(broken, 'block', t.tracer));
    expect(failure.type).toBe('TEST_INTEGRITY_GUARD_UNAVAILABLE');
    expect(t.addActivityEvent).toHaveBeenCalled();
  });

  it('degrades in warn mode and says so', async () => {
    const t = tracer();
    const broken = {
      exec: async () => {
        throw new Error('no git');
      },
    };
    await expect(startTestIntegritySession(broken, 'warn', t.tracer)).resolves.toBeUndefined();
    expect(t.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        outputJson: expect.objectContaining({ degraded: true }),
      })
    );
  });
});
