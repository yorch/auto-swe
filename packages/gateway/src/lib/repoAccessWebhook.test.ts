import { describe, expect, it } from 'vitest';
import { classifyAccessEvent } from './repoAccessWebhook.js';

const REPO = { name: 'payments', owner: { login: 'acme' } };

describe('classifyAccessEvent', () => {
  it('narrows a collaborator change to the one affected pair', () => {
    // The common case, and the one worth being precise about: re-asking about
    // the whole team for one person's change multiplies the API cost.
    expect(
      classifyAccessEvent('member', {
        action: 'removed',
        member: { login: 'octocat' },
        repository: REPO,
      })
    ).toEqual({ kind: 'pair', login: 'octocat', org: 'acme', repo: 'payments' });
  });

  it('treats a permission downgrade like any other collaborator change', () => {
    // `edited` is how GitHub reports write -> read. Ignoring it would leave a
    // demoted user recorded as still having write until the next sweep.
    expect(
      classifyAccessEvent('member', {
        action: 'edited',
        member: { login: 'octocat' },
        repository: REPO,
      })
    ).toMatchObject({ kind: 'pair', login: 'octocat' });
  });

  it('invalidates the whole repository when a team gains or loses it', () => {
    // No member is named in the payload, so every member's answer is suspect.
    for (const action of ['added_to_repository', 'removed_from_repository']) {
      expect(classifyAccessEvent('team', { action, repository: REPO })).toEqual({
        kind: 'repo',
        org: 'acme',
        repo: 'payments',
      });
    }
  });

  it('ignores team events that do not change repository access', () => {
    expect(classifyAccessEvent('team', { action: 'edited', repository: REPO })).toMatchObject({
      kind: 'ignored',
    });
  });

  it('invalidates a whole user when their GitHub team membership changes', () => {
    // Which repositories the team reaches is not in the payload.
    expect(
      classifyAccessEvent('membership', { action: 'removed', member: { login: 'octocat' } })
    ).toEqual({ kind: 'user', login: 'octocat' });
  });

  it('invalidates a whole user when they leave the organization', () => {
    expect(
      classifyAccessEvent('organization', {
        action: 'member_removed',
        membership: { user: { login: 'octocat' } },
      })
    ).toEqual({ kind: 'user', login: 'octocat' });
  });

  it('ignores organization events that do not remove access', () => {
    expect(
      classifyAccessEvent('organization', {
        action: 'member_added',
        membership: { user: { login: 'octocat' } },
      })
    ).toMatchObject({ kind: 'ignored' });
  });

  it('invalidates a repository on visibility, transfer, archival and deletion', () => {
    for (const action of [
      'privatized',
      'publicized',
      'transferred',
      'archived',
      'unarchived',
      'deleted',
    ]) {
      expect(classifyAccessEvent('repository', { action, repository: REPO })).toMatchObject({
        kind: 'repo',
      });
    }
  });

  it('ignores repository events that cannot change access', () => {
    expect(
      classifyAccessEvent('repository', { action: 'renamed', repository: REPO })
    ).toMatchObject({ kind: 'ignored' });
  });

  it('ignores unrelated events by name rather than by omission', () => {
    const result = classifyAccessEvent('push', { repository: REPO });
    expect(result).toMatchObject({ kind: 'ignored' });
    expect((result as { reason: string }).reason).toContain('push');
  });

  it('never throws on a malformed payload', () => {
    // Payloads are third-party data. A parse failure here would 500 the webhook
    // and make GitHub redeliver it indefinitely.
    for (const body of [null, undefined, 'a string', 42, [], {}]) {
      expect(classifyAccessEvent('member', body)).toMatchObject({ kind: 'ignored' });
    }
    expect(classifyAccessEvent('member', { member: { login: 'octocat' } })).toMatchObject({
      kind: 'ignored',
    });
    expect(classifyAccessEvent('member', { repository: REPO })).toMatchObject({ kind: 'ignored' });
    expect(
      classifyAccessEvent('member', { member: { login: '' }, repository: REPO })
    ).toMatchObject({ kind: 'ignored' });
    expect(
      classifyAccessEvent('member', { member: { login: 'x' }, repository: { name: 'r' } })
    ).toMatchObject({ kind: 'ignored' });
  });
});
