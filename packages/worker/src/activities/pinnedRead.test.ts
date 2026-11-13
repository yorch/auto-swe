/**
 * The end marker of a pinned git read. The Kubernetes exec capture stops reading stdout at a cap
 * and reports exit 0, so a padded diff came back short and looked complete. Every pinned read now
 * ends with a line carrying a per-call nonce that the command prints after git has exited; a
 * stdout without it is refused, and each consumer fails closed.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertCommittedTreeWithinAllowedPaths,
  commitStaged,
  diffForResult,
  execPinned,
  readTestIntegrityDiff,
  readTreeChange,
  startPathGuard,
} from './allowedPaths.js';

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
const real = { exec: async (cmd: string) => sh(cmd) };
/** A backend that silently drops the end of stdout, as the Kubernetes capture does at its cap. */
const truncating = {
  exec: async (cmd: string) => {
    const out = sh(cmd);
    return out.slice(0, Math.max(0, out.length - 10));
  },
};
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'pinned-read-'));
  sh('git init -q -b main && git config user.name t && git config user.email t@t');
  write('a.txt', 'base\n');
  sh('git add -A && git commit -q -m base && git update-ref refs/remotes/origin/main HEAD');
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

describe('execPinned', () => {
  it('returns the output exactly, without the marker', async () => {
    expect(await execPinned(real, "printf 'one\\ntwo\\n'")).toBe('one\ntwo\n');
    expect(await execPinned(real, 'printf nothing-trailing')).toBe('nothing-trailing');
    expect(await execPinned(real, 'true')).toBe('');
  });

  it('keeps a failing command failing', async () => {
    await expect(execPinned(real, 'echo partial; exit 3')).rejects.toThrow();
  });

  it('refuses output cut short, and output that merely looks like a marker', async () => {
    await expect(execPinned(truncating, "printf 'one\\ntwo\\n'")).rejects.toThrow(/cut short/);
    const forged = { exec: async () => 'x\n0123456789abcdef0123456789abcdef\n' };
    await expect(execPinned(forged, 'true')).rejects.toThrow(/cut short/);
  });

  it('uses a different marker on every call', async () => {
    const seen: string[] = [];
    const spy = {
      exec: async (cmd: string) => {
        seen.push(/printf '\\n%s\\n' ([0-9a-f]+)/.exec(cmd)?.[1] ?? '');
        return sh(cmd);
      },
    };
    await execPinned(spy, 'true');
    await execPinned(spy, 'true');
    expect(seen[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(seen[0]).not.toBe(seen[1]);
  });
});

describe('each pinned consumer fails closed on a truncated read', () => {
  it('the scanner diff', async () => {
    const guard = await startPathGuard(real, 'main', undefined);
    write('new.ts', 'export const x = 1;\n'.repeat(50));
    sh('git add -A');
    const sha = await commitStaged(real, 'auto: implement', guard);
    expect((await diffForResult(real, guard, sha)).length).toBeGreaterThan(100);
    await expect(diffForResult(truncating, guard, sha)).rejects.toMatchObject({
      nonRetryable: true,
      type: 'SECURITY_GATE_UNAVAILABLE',
    });
  });

  it('the test-integrity reads', async () => {
    const start = sh('git rev-parse HEAD').trim();
    write('t.test.ts', 'it("a", () => {});\n'.repeat(20));
    sh('git add -A && git commit -q -m t');
    const head = sh('git rev-parse HEAD').trim();
    for (const kind of ['patch', 'name-status'] as const) {
      expect((await readTestIntegrityDiff(real, start, head, kind, [])).length).toBeGreaterThan(0);
      await expect(readTestIntegrityDiff(truncating, start, head, kind, [])).rejects.toThrow(
        /cut short/
      );
    }
    await expect(readTreeChange(truncating, start, head)).rejects.toThrow();
  });

  it('the allowed-paths comparison', async () => {
    const guard = await startPathGuard(real, 'main', ['a.txt']);
    write('a.txt', 'changed\n');
    sh('git add -A && git commit -q -m c');
    const sha = sh('git rev-parse HEAD').trim();
    await expect(assertCommittedTreeWithinAllowedPaths(real, guard, sha)).resolves.toBeUndefined();
    await expect(
      assertCommittedTreeWithinAllowedPaths(truncating, guard, sha)
    ).rejects.toMatchObject({
      type: 'DIFF_CHECK_FAILED',
    });
  });
});
