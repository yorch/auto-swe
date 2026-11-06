import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeBaseCheckout } from '../lib/runKnowledgeBases.js';
import { cloneKnowledgeBases } from './workspace.js';

vi.mock('../lib/activityLog.js', () => ({ logWarn: vi.fn() }));
const sha = 'a'.repeat(40);
const kb = (extra: Partial<KnowledgeBaseCheckout> = {}): KnowledgeBaseCheckout => ({
  authedCloneUrl: 'https://x-access-token:private-kb-token@github.com/owner/repo.git',
  flaggedFiles: ['docs/flagged.md'],
  knowledgeBaseId: 'kb',
  mountName: '../Reference docs',
  owner: 'owner',
  path: 'docs',
  repo: 'repo',
  sha,
  snapshotId: 'snapshot',
  ...extra,
});
const fixtures: string[] = [];
afterEach(() => {
  for (const path of fixtures.splice(0)) {
    execFileSync('chmod', ['-R', 'u+w', path]);
    rmSync(path, { force: true, recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kb-checkout-'));
  fixtures.push(root);
  const repo = join(root, 'source');
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'README.md'), 'outside KB path');
  writeFileSync(join(repo, 'docs', 'README.md'), 'pinned content');
  writeFileSync(join(repo, 'docs', 'flagged.md'), 'must not reach the agent');
  symlinkSync('/etc/passwd', join(repo, 'docs', 'escape'));
  const commit = () => {
    git('add', '--all');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-q',
      '-m',
      'fixture'
    );
    return git('rev-parse', 'HEAD');
  };
  const pinnedSha = commit();
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const exec = vi.fn(async (script: string, options?: { secretEnv?: Record<string, string> }) =>
    execFileSync('sh', ['-c', script.replaceAll('/workspace', workspace)], {
      encoding: 'utf8',
      env: { ...process.env, ...options?.secretEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  );
  return {
    checkout: kb({ authedCloneUrl: `file://${repo}`, path: 'docs/', sha: pinnedSha }),
    commit,
    exec,
    git,
    pinnedSha,
    repo,
    root,
    workspace,
  };
}

describe('knowledge base checkout', () => {
  it('executes shallow pinned sparse checkout, deletes flagged files/symlinks and publishes read-only subdirectory contents', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'docs', 'README.md'), 'newer content');
    f.commit();
    const mounted = await cloneKnowledgeBases({ exec: f.exec }, [f.checkout]);
    expect(mounted).toHaveLength(1);
    const path = join(f.workspace, 'kb', 'Reference-docs');
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('pinned content');
    expect(existsSync(join(path, 'flagged.md'))).toBe(false);
    expect(existsSync(join(path, 'escape'))).toBe(false);
    expect(existsSync(join(path, '.git'))).toBe(false);
    expect(readdirSync(f.workspace)).toEqual(['kb']);
    expect(statSync(path).mode & 0o222).toBe(0);
    expect(statSync(join(path, 'README.md')).mode & 0o222).toBe(0);
    expect(f.exec.mock.calls[0][0]).toContain('sparse-checkout');
    expect(f.exec.mock.calls[0][0]).toContain(`fetch --depth=1 --no-tags origin '${f.pinnedSha}'`);
    expect(JSON.stringify(mounted)).not.toContain('authedCloneUrl');
  });

  it('also supports a root checkout without leaving git metadata', async () => {
    const f = fixture();
    const [mounted] = await cloneKnowledgeBases({ exec: f.exec }, [{ ...f.checkout, path: '' }]);
    expect(mounted).toBeDefined();
    const path = join(f.workspace, 'kb', 'Reference-docs');
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('outside KB path');
    expect(existsSync(join(path, 'docs', 'flagged.md'))).toBe(false);
    expect(existsSync(join(path, '.git'))).toBe(false);
  });

  it('drops a checkout exceeding 50 MiB and removes staging and destination directories', async () => {
    const f = fixture();
    writeFileSync(join(f.repo, 'docs', 'large.txt'), Buffer.alloc(51 * 1024 * 1024));
    expect(
      await cloneKnowledgeBases({ exec: f.exec }, [{ ...f.checkout, sha: f.commit() }])
    ).toEqual([]);
    expect(readdirSync(f.workspace)).toEqual(['kb']);
    expect(readdirSync(join(f.workspace, 'kb'))).toEqual([]);
  });

  it('keeps credentials exclusively in secretEnv, not commands or returned mounts', async () => {
    const exec = vi.fn(async () => '');
    const result = await cloneKnowledgeBases({ exec }, [kb()]);
    const calls = exec.mock.calls as unknown as Array<
      [string, { secretEnv: Record<string, string> }]
    >;
    expect(calls[0][0]).not.toContain('private-kb-token');
    expect(calls[0][0]).not.toContain(
      Buffer.from('x-access-token:private-kb-token').toString('base64')
    );
    expect(Object.values(calls[0][1].secretEnv)).toEqual([
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:private-kb-token').toString('base64')}`,
    ]);
    expect(JSON.stringify(result)).not.toContain('private-kb-token');
  });

  it('continues after a failure, cleans up, and disambiguates sanitized names', async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error('clone failed')).mockResolvedValue('');
    const result = await cloneKnowledgeBases({ exec }, [kb(), kb({ knowledgeBaseId: 'second' })]);
    expect(exec.mock.calls[1][0]).toContain(
      "rm -rf -- '/workspace/kb/Reference-docs' '/workspace/.kb-checkout-Reference-docs'"
    );
    expect(result.map((item) => item.mountPath)).toEqual(['/workspace/kb/Reference-docs-x']);
  });

  it.each([
    { path: '../escape' },
    { path: '/' },
    { sha: '--upload-pack=command' },
    { flaggedFiles: ['../../target-repo/a'] },
  ])('rejects unsafe inputs without cloning: %j', async (unsafe) => {
    const exec = vi.fn(async () => '');
    expect(await cloneKnowledgeBases({ exec }, [kb(unsafe)])).toEqual([]);
    expect(exec.mock.calls).toHaveLength(1);
    expect((exec.mock.calls[0] as unknown as [string])[0]).not.toContain('fetch');
  });

  it('does nothing for an empty set and caps checkout attempts', async () => {
    const exec = vi.fn(async () => '');
    expect(await cloneKnowledgeBases({ exec }, [])).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
    expect(
      await cloneKnowledgeBases(
        { exec },
        Array.from({ length: 6 }, () => kb())
      )
    ).toHaveLength(4);
  });
});
