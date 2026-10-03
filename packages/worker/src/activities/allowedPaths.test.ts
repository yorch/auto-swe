import { describe, expect, it, vi } from 'vitest';
import { assertDiffWithinAllowedPaths } from './allowedPaths.js';

const workspace = (out: string) => ({ exec: vi.fn(async () => out) });

describe('assertDiffWithinAllowedPaths', () => {
  it('does nothing, and runs nothing, when allowedPaths is unset', async () => {
    const ws = workspace('anything\0');
    await expect(assertDiffWithinAllowedPaths(ws, 'main', undefined)).resolves.toBeUndefined();
    expect(ws.exec).not.toHaveBeenCalled();
  });

  it('passes a change confined to the allowed paths, and an empty one', async () => {
    await expect(
      assertDiffWithinAllowedPaths(workspace('a/b.ts\0'), 'main', ['a/b.ts'])
    ).resolves.toBeUndefined();
    await expect(
      assertDiffWithinAllowedPaths(workspace(''), 'main', ['a/b.ts'])
    ).resolves.toBeUndefined();
  });

  it('fails non-retryably, naming the stray files, when anything else changed', async () => {
    await expect(
      assertDiffWithinAllowedPaths(workspace('a/b.ts\0.github/workflows/x.yml\0'), 'main', [
        'a/b.ts',
      ])
    ).rejects.toMatchObject({
      message: expect.stringContaining('.github/workflows/x.yml'),
      nonRetryable: true,
      type: 'DIFF_OUTSIDE_ALLOWED_PATHS',
    });
  });

  it('compares the whole branch against the default branch, with renames as both paths', async () => {
    const ws = workspace('');
    await assertDiffWithinAllowedPaths(ws, "ma'in", ['a']);
    const cmd = (ws.exec.mock.calls[0] as unknown as [string])[0];
    expect(cmd).toContain('git diff --cached --name-only --no-renames -z');
    expect(cmd).toContain("origin/'ma'\\''in'");
  });
});
