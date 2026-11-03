import { describe, expect, it } from 'vitest';
import { normalizePushEvent } from './push.js';

const BEFORE = 'a'.repeat(40);
const AFTER = 'b'.repeat(40);

function body(over: Record<string, unknown> = {}) {
  return {
    after: AFTER,
    before: BEFORE,
    commits: [{ added: ['a.txt'], modified: ['src/b.ts'], removed: [] }],
    compare: 'https://github.com/acme/api/compare/aaa...bbb',
    deleted: false,
    forced: false,
    head_commit: { message: 'Fix the thing' },
    ref: 'refs/heads/main',
    repository: { full_name: 'acme/api', html_url: 'https://github.com/acme/api' },
    sender: { id: 42, login: 'octocat', type: 'User' },
    ...over,
  };
}

describe('normalizePushEvent', () => {
  it('maps a push of commits to a branch by a person', () => {
    expect(normalizePushEvent(body())).toMatchObject({
      facts: {
        after: AFTER,
        before: BEFORE,
        branch: 'main',
        commitCount: 1,
        files: ['a.txt', 'src/b.ts'],
        filesTruncated: false,
        message: 'Fix the thing',
        senderId: '42',
        senderLogin: 'octocat',
      },
      org: 'acme',
      repoName: 'api',
      type: 'push',
    });
  });

  it('keeps a branch name with slashes whole', () => {
    expect(normalizePushEvent(body({ ref: 'refs/heads/release/1.2' }))).toMatchObject({
      facts: { branch: 'release/1.2' },
    });
  });

  it('does not ignore a forced push to a new commit', () => {
    expect(normalizePushEvent(body({ forced: true })).type).toBe('push');
  });

  it('ignores a force push back to an ancestor, which carries no commits', () => {
    expect(normalizePushEvent(body({ commits: [], forced: true })).type).toBe('ignored');
  });

  it('drops hidden HTML comments from the commit message before bounding it', () => {
    const message = `Squash <!-- hidden instruction -->merge\n${'x'.repeat(3000)}`;
    const out = normalizePushEvent(body({ head_commit: { message } }));
    expect(out).toMatchObject({ type: 'push' });
    const text = (out as { facts: { message: string } }).facts.message;
    expect(text.startsWith('Squash merge')).toBe(true);
    expect(text).not.toContain('hidden');
    expect(text.length).toBe(2000);
  });

  it('does not decide on the platform prefix: that is the engine’s, with the configured one', () => {
    expect(normalizePushEvent(body({ ref: 'refs/heads/auto/JIRA-1' }))).toMatchObject({
      facts: { branch: 'auto/JIRA-1' },
      type: 'push',
    });
  });

  it.each([
    ['a tag', body({ ref: 'refs/tags/v1' })],
    ['a deletion', body({ after: '0'.repeat(40), deleted: true })],
    ['an all-zero after', body({ after: '0'.repeat(40) })],
    ['no commits', body({ commits: [] })],
    ['a missing commit list', body({ commits: undefined })],
    ['a bot', body({ sender: { id: 1, login: 'auto-swe[bot]', type: 'Bot' } })],
    ['an unusable sha', body({ after: 'xyz' })],
  ])('ignores %s', (_name, payload) => {
    expect(normalizePushEvent(payload).type).toBe('ignored');
  });

  it('does not recognise another shape', () => {
    expect(normalizePushEvent({ hello: 'world' })).toEqual({ type: 'unrecognized' });
  });

  it('de-duplicates and bounds the file list and the message, flagging truncation', () => {
    const many = Array.from({ length: 400 }, (_, i) => `f${i}.ts`);
    const event = normalizePushEvent(
      body({
        commits: [{ added: many, modified: ['f0.ts'] }],
        head_commit: { message: 'm'.repeat(5_000) },
      })
    );
    expect(event.type).toBe('push');
    if (event.type === 'push') {
      expect(event.facts.files).toHaveLength(300);
      expect(event.facts.filesTruncated).toBe(true);
      expect(event.facts.message).toHaveLength(2_000);
    }
  });

  it('flags a push at GitHub’s commit limit as possibly incomplete', () => {
    const commits = Array.from({ length: 20 }, () => ({ added: ['a'] }));
    expect(normalizePushEvent(body({ commits }))).toMatchObject({
      facts: { commitCount: 20, filesTruncated: true },
    });
  });
});
