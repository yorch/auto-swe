import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Workspace } from '../activities/workspace.js';
import { applyStoredPatch, storedPatchPaths } from './storedPatch.js';

const DIFF = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});
async function checkout() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stored-review-'));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  await fs.writeFile(path.join(dir, 'a.txt'), 'old\n');
  git('add', 'a.txt');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base');
  const commands: string[] = [];
  const workspace = {
    exec: async (command: string) => {
      commands.push(command);
      return execSync(command, { cwd: dir, encoding: 'utf8' });
    },
    execStdin: async (command: string, input: string) => {
      commands.push(command);
      return execSync(command, { cwd: dir, encoding: 'utf8', input });
    },
  } as unknown as Workspace;
  return { baseSha: git('rev-parse', 'HEAD'), commands, dir, git, workspace };
}
describe('stored patch verification', () => {
  it('checks before applying, creates only a local commit, and leaves the branch remote-free', async () => {
    const f = await checkout();
    const head = await applyStoredPatch(f.workspace, { baseSha: f.baseSha, diff: DIFF }, true);
    expect(head).not.toBe(f.baseSha);
    expect(f.git('rev-parse', 'HEAD')).toBe(head);
    expect(await fs.readFile(path.join(f.dir, 'a.txt'), 'utf8')).toBe('new\n');
    expect(f.commands.findIndex((s) => s.includes('apply --check'))).toBeLessThan(
      f.commands.findIndex((s) => s.includes('apply --index'))
    );
    expect(f.commands.some((s) => /push/.test(s))).toBe(false);
    expect(f.git('remote')).toBe('');
  });
  it('leaves the patch staged on the original base for a deliver:none follow-up', async () => {
    const f = await checkout();
    expect(await applyStoredPatch(f.workspace, { baseSha: f.baseSha, diff: DIFF })).toBe(f.baseSha);
    expect(f.git('rev-parse', 'HEAD')).toBe(f.baseSha);
    expect(f.git('diff', '--cached')).toContain('+new');
  });
  it('does not apply a patch with wrong context or a moved checkout', async () => {
    const f = await checkout();
    await expect(
      applyStoredPatch(f.workspace, { baseSha: '0'.repeat(40), diff: DIFF })
    ).rejects.toThrow('does not match');
    await expect(
      applyStoredPatch(f.workspace, { baseSha: f.baseSha, diff: DIFF.replace('-old', '-other') })
    ).rejects.toThrow();
    expect(f.commands.filter((s) => s.includes('apply --index'))).toHaveLength(0);
    expect(await fs.readFile(path.join(f.dir, 'a.txt'), 'utf8')).toBe('old\n');
  });
  it('rejects paths through existing symlinks without touching the target', async () => {
    const f = await checkout();
    await fs.mkdir(path.join(f.dir, 'outside'));
    await fs.writeFile(path.join(f.dir, 'outside/a.txt'), 'old\n');
    await fs.symlink('outside', path.join(f.dir, 'link'));
    await expect(
      applyStoredPatch(f.workspace, {
        baseSha: f.baseSha,
        diff: DIFF.replaceAll('a.txt', 'link/a.txt'),
      })
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(f.dir, 'outside/a.txt'), 'utf8')).toBe('old\n');
  });
  it.each([
    '../escape',
    '/absolute',
    '.git/config',
    'a/../../escape',
    'a\\escape',
    '.GIT/hooks/x',
    'a\tb',
    'a/./b',
  ])('refuses unsafe path %s', (name) => {
    expect(() => storedPatchPaths(DIFF.replaceAll('a.txt', name))).toThrow();
  });
  it.each([
    '',
    '\0',
    'GIT binary patch',
    'Binary files a/a and b/a differ',
    'diff --git "a/a" "b/a"',
    `${DIFF}\nnew file mode 120000`,
    `${DIFF}\nindex abc..def 160000`,
  ])('refuses empty, binary or unsupported patches', (diff) => {
    expect(() => storedPatchPaths(diff)).toThrow();
  });
});
