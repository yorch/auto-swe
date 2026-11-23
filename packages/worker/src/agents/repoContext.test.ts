import { describe, expect, it, vi } from 'vitest';
import {
  capRepoContext,
  isRepoContextFile,
  MAX_REPO_CONTEXT_BYTES,
  REPO_CONTEXT_FILES,
  type RepoEntry,
  readRepoContext,
  readWorkspaceRepoContext,
  repoContextBlock,
} from './repoContext.js';

const WORKSPACE = '/workspace/target-repo';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** A base commit holding `entries`, keyed by path, as the workspace reader answers. */
function commit(entries: Record<string, RepoEntry>) {
  return vi.fn(async (rel: string) => entries[rel] ?? null);
}

const file = (content: string): RepoEntry => ({ content, mode: '100644' });
const link = (target: string): RepoEntry => ({ content: target, mode: '120000' });

describe('capRepoContext', () => {
  it('leaves a file under the cap alone', () => {
    expect(capRepoContext('Run yarn test.')).toBe('Run yarn test.');
    expect(capRepoContext('')).toBe('');
  });

  it('cuts at the byte cap, and never through a multi-byte character', () => {
    const filled = 'a'.repeat(MAX_REPO_CONTEXT_BYTES - 1);
    const capped = capRepoContext(`${filled}é`);
    expect(Buffer.byteLength(capped, 'utf8')).toBeLessThanOrEqual(MAX_REPO_CONTEXT_BYTES);
    // The split character is dropped, not turned into a replacement glyph.
    expect(capped).not.toContain('\uFFFD');
    expect(capped.length).toBe(MAX_REPO_CONTEXT_BYTES - 1);
  });
});

describe('readRepoContext', () => {
  it('prefers AGENTS.md and never asks for the second name once it is found', async () => {
    const read = commit({ 'AGENTS.md': file('Use pnpm.') });
    await expect(readRepoContext(SHA, read)).resolves.toEqual({
      commitSha: SHA.slice(0, 7),
      content: 'Use pnpm.',
      path: `${WORKSPACE}/AGENTS.md`,
    });
    expect(read.mock.calls.map(([rel]) => rel)).toEqual(['AGENTS.md']);
    expect(REPO_CONTEXT_FILES[0]).toBe('AGENTS.md');
  });

  it('falls back to CLAUDE.md when AGENTS.md is absent', async () => {
    const read = commit({ 'CLAUDE.md': file('Claude rules.') });
    await expect(readRepoContext(SHA, read)).resolves.toMatchObject({
      content: 'Claude rules.',
      path: `${WORKSPACE}/CLAUDE.md`,
    });
    expect(read.mock.calls.map(([rel]) => rel)).toEqual(['AGENTS.md', 'CLAUDE.md']);
  });

  it('reads neither name as no context', async () => {
    await expect(readRepoContext(SHA, commit({}))).resolves.toBeNull();
  });

  it('accepts an empty file as present', async () => {
    await expect(readRepoContext(SHA, commit({ 'AGENTS.md': file('') }))).resolves.toMatchObject({
      content: '',
      path: `${WORKSPACE}/AGENTS.md`,
    });
  });

  it('cuts a file over the cap', async () => {
    const context = await readRepoContext(
      SHA,
      commit({ 'AGENTS.md': file('x'.repeat(MAX_REPO_CONTEXT_BYTES * 2)) })
    );
    expect(Buffer.byteLength(context?.content ?? '', 'utf8')).toBe(MAX_REPO_CONTEXT_BYTES);
  });

  it('follows a symlink inside the commit, and names the file it reached', async () => {
    const read = commit({ 'AGENTS.md': link('CLAUDE.md'), 'CLAUDE.md': file('Real rules.') });
    await expect(readRepoContext(SHA, read)).resolves.toMatchObject({
      content: 'Real rules.',
      path: `${WORKSPACE}/CLAUDE.md`,
    });
  });

  it('follows a relative symlink into a directory', async () => {
    const read = commit({
      'AGENTS.md': link('docs/agents.md'),
      'docs/agents.md': file('Nested rules.'),
    });
    await expect(readRepoContext(SHA, read)).resolves.toMatchObject({
      content: 'Nested rules.',
      path: `${WORKSPACE}/docs/agents.md`,
    });
  });

  it('refuses a symlink that leaves the repository, and moves on to the next name', async () => {
    for (const target of ['/etc/passwd', '../../etc/passwd', 'docs/../../outside.md']) {
      const read = commit({
        'AGENTS.md': link(target),
        'CLAUDE.md': file('Fallback rules.'),
      });
      await expect(readRepoContext(SHA, read)).resolves.toMatchObject({
        content: 'Fallback rules.',
        path: `${WORKSPACE}/CLAUDE.md`,
      });
      // The target is never opened.
      expect(read.mock.calls.map(([rel]) => rel)).not.toContain('/etc/passwd');
    }
  });

  it('gives up on a symlink that points at itself', async () => {
    const read = commit({ 'AGENTS.md': link('AGENTS.md') });
    await expect(readRepoContext(SHA, read)).resolves.toBeNull();
    // Bounded: the hops allowed, per name tried, and it stops.
    expect(read.mock.calls.length).toBeLessThanOrEqual(8);
    expect(new Set(read.mock.calls.map(([rel]) => rel))).toEqual(
      new Set(['AGENTS.md', 'CLAUDE.md'])
    );
  });

  it('reads an executable file, and refuses a tree of the same name', async () => {
    await expect(
      readRepoContext(SHA, commit({ 'AGENTS.md': { content: 'Rules.', mode: '100755' } }))
    ).resolves.toMatchObject({ content: 'Rules.' });
    await expect(
      readRepoContext(SHA, commit({ 'AGENTS.md': { content: '', mode: '040000' } }))
    ).resolves.toBeNull();
  });

  it('fails rather than quietly running under the next name when a read breaks', async () => {
    const read = vi.fn(async (rel: string) => {
      if (rel === 'AGENTS.md') {
        throw new Error('git is unhappy');
      }
      return file('Second chance.');
    });
    await expect(readRepoContext(SHA, read)).rejects.toThrow('git is unhappy');
    // `CLAUDE.md` is never consulted: whatever it says is not what the run was told it follows.
    expect(read.mock.calls.map(([rel]) => rel)).toEqual(['AGENTS.md']);
  });

  it('asks git for nothing when the workspace has no commit to read', async () => {
    const read = commit({ 'AGENTS.md': file('Rules.') });
    for (const sha of ['', 'HEAD', '--all', 'not-a-sha']) {
      await expect(readRepoContext(sha, read)).resolves.toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe('readWorkspaceRepoContext', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

  it('hands back what the workspace resolved at creation', () => {
    const context = readWorkspaceRepoContext({
      repoContext: {
        commitSha: SHA.slice(0, 7),
        content: 'Be careful.',
        path: `${WORKSPACE}/AGENTS.md`,
      },
    });

    expect(context).toMatchObject({ commitSha: SHA.slice(0, 7), content: 'Be careful.' });
    expect(repoContextBlock(context)).toContain(`(commit ${SHA.slice(0, 7)})`);
  });

  it('offers nothing from a workspace that resolved none', () => {
    expect(readWorkspaceRepoContext({ repoContext: null })).toBeNull();
    expect(readWorkspaceRepoContext({})).toBeNull();
  });
});

describe('repoContextBlock', () => {
  it('names the file and the commit it was read at, and is empty without one', () => {
    expect(repoContextBlock(null)).toBe('');
    const block = repoContextBlock({
      commitSha: 'a1b2c3d',
      content: 'Run yarn test.',
      path: `${WORKSPACE}/AGENTS.md`,
    });
    expect(block).toContain('# Project Context');
    expect(block).toContain(`## ${WORKSPACE}/AGENTS.md (commit a1b2c3d)`);
    expect(block).toContain('Run yarn test.');
  });
});

describe('isRepoContextFile', () => {
  it('matches the two names at the checkout root, in any case', () => {
    for (const name of ['AGENTS.md', 'agents.md', 'CLAUDE.md', 'Claude.md']) {
      expect(isRepoContextFile(name)).toBe(true);
    }
  });

  it('does not match a nested file or a lookalike', () => {
    for (const rel of ['docs/AGENTS.md', 'src/CLAUDE.md', 'AGENTS.md.bak', 'AGENT.md']) {
      expect(isRepoContextFile(rel)).toBe(false);
    }
  });
});
