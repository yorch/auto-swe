import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import type { RepoSetupHost } from './repoSetupRun.js';
import { readSetupEntry } from './repoSetupRun.js';

/**
 * `readSetupEntry` against real git: it is the read the repository's instruction file goes
 * through, and the whole point of it is what git reports about a commit's tree.
 */

const RUN = promisify(execFile);

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const dir = mkdtempSync(join(tmpdir(), 'setup-entry-'));
afterAll(() => {
  rmSync(dir, { force: true, recursive: true });
});

/** A checkout at `dir`, and a host whose `capture` runs the command there. */
const git = (...args: string[]) => RUN('git', args, { cwd: dir });
const head = async () => (await git('rev-parse', 'HEAD')).stdout.trim();

const host: RepoSetupHost = {
  capture: async (command: string, opts: { maxOutputBytes?: number } = {}) => {
    try {
      const { stdout, stderr } = await RUN('sh', ['-c', command], { cwd: dir });
      const capped = opts.maxOutputBytes
        ? Buffer.from(stdout, 'utf8').subarray(0, opts.maxOutputBytes).toString('utf8')
        : stdout;
      return { exitCode: 0, signal: null, stderr, stdout: capped } as never;
    } catch (err) {
      const failed = err as { code?: number; stderr?: string; stdout?: string };
      return {
        exitCode: failed.code ?? 1,
        signal: null,
        stderr: failed.stderr ?? '',
        stdout: failed.stdout ?? '',
      } as never;
    }
  },
} as unknown as RepoSetupHost;

describe.skipIf(!gitAvailable)('readSetupEntry, against a real repository', () => {
  it('reads a committed file and the mode git recorded', async () => {
    await git('init', '--quiet');
    await git('config', 'user.email', 'agent@example.com');
    await git('config', 'user.name', 'agent');
    writeFileSync(join(dir, 'AGENTS.md'), 'Run yarn test.\n');
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n');
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'base');
    const sha = await head();

    await expect(readSetupEntry(host, sha, 'AGENTS.md', 64 * 1024)).resolves.toEqual({
      content: 'Run yarn test.\n',
      mode: '100644',
    });
    // The executable bit is a mode of its own, and still a file this reads.
    await expect(readSetupEntry(host, sha, 'run.sh', 64 * 1024)).resolves.toMatchObject({
      mode: '100644',
    });
  });

  it('reports a symlink as a link, not as the file it names', async () => {
    rmSync(join(dir, 'AGENTS.md'), { force: true });
    writeFileSync(join(dir, 'CLAUDE.md'), 'Real instructions.\n');
    symlinkSync('CLAUDE.md', join(dir, 'AGENTS.md'));
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'link');
    const sha = await head();

    await expect(readSetupEntry(host, sha, 'AGENTS.md', 64 * 1024)).resolves.toEqual({
      content: 'CLAUDE.md',
      mode: '120000',
    });
  });

  it('finds nothing for a path the commit does not have, or a directory', async () => {
    const sha = await head();
    await expect(readSetupEntry(host, sha, 'NOPE.md', 64 * 1024)).resolves.toBeNull();
    await expect(readSetupEntry(host, sha, 'src', 64 * 1024)).resolves.toBeNull();
  });

  it('reads the commit’s own object even when a replace ref says otherwise', async () => {
    const sha = await head();
    const original = await readSetupEntry(host, sha, 'CLAUDE.md', 64 * 1024);
    // A repository can record a replacement for any object. `--no-replace-objects` is what stops
    // it rewriting what this read reports, and reading by the object id the listing named is what
    // stops a second resolution disagreeing with the first.
    const blob = (await git('rev-parse', `${sha}:CLAUDE.md`)).stdout.trim();
    const forged = (
      await RUN('sh', ['-c', 'printf forged | git hash-object -w --stdin'], { cwd: dir })
    ).stdout.trim();
    await git('replace', blob, forged);

    await expect(readSetupEntry(host, sha, 'CLAUDE.md', 64 * 1024)).resolves.toEqual(original);
    // The replacement is real: a reader that did not disable it would see the forgery.
    await expect(
      RUN('git', ['cat-file', '-p', blob], { cwd: dir }).then((r) => r.stdout)
    ).resolves.toBe('forged');
  });

  it('caps what it reads, and refuses a ref that is not a commit id', async () => {
    const sha = await head();
    writeFileSync(join(dir, 'big.md'), 'x'.repeat(5000));
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'big');
    const bigSha = await head();

    const entry = await readSetupEntry(host, bigSha, 'big.md', 100);
    expect(entry?.content.length).toBe(101);

    // Never a revision expression or an option: this reads one commit's tree by id.
    await expect(readSetupEntry(host, 'HEAD', 'AGENTS.md', 1024)).rejects.toThrow(
      'needs a commit id'
    );
    await expect(readSetupEntry(host, '', 'AGENTS.md', 1024)).rejects.toThrow('needs a commit id');
    expect(sha).toHaveLength(40);
  });
});
