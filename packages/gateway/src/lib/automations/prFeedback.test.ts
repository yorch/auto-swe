import { describe, expect, it } from 'vitest';
import { normalizePrFeedbackEvent } from './prFeedback.js';

const SENDER = { id: 42, login: 'octocat', type: 'User' };
const REPO = { full_name: 'acme/api', html_url: 'https://github.com/acme/api', id: 7 };
const PR = {
  head: { ref: 'auto/prfb-9-1', repo: { id: 7 } },
  number: 9,
  state: 'open',
};

function reviewBody(over: Record<string, unknown> = {}, review: Record<string, unknown> = {}) {
  return {
    action: 'submitted',
    pull_request: { ...PR },
    repository: { ...REPO },
    review: {
      body: 'Please handle the null case.',
      html_url: 'https://github.com/acme/api/pull/9#pullrequestreview-777',
      id: 777,
      state: 'changes_requested',
      submitted_at: '2026-10-01T00:00:00Z',
      ...review,
    },
    sender: { ...SENDER },
    ...over,
  };
}

function reviewCommentBody(
  over: Record<string, unknown> = {},
  comment: Record<string, unknown> = {}
) {
  return {
    action: 'created',
    comment: {
      body: '/auto-swe fix the flaky test',
      created_at: '2026-10-01T00:00:00Z',
      html_url: 'https://github.com/acme/api/pull/9#discussion_r888',
      id: 888,
      ...comment,
    },
    pull_request: { ...PR },
    repository: { ...REPO },
    sender: { ...SENDER },
    ...over,
  };
}

function issueCommentBody(
  over: Record<string, unknown> = {},
  issue: Record<string, unknown> = {},
  comment: Record<string, unknown> = {}
) {
  return {
    action: 'created',
    comment: {
      body: '/auto-swe fix\nwhile you are there, update the test',
      created_at: '2026-10-01T00:00:00Z',
      html_url: 'https://github.com/acme/api/pull/9#issuecomment-999',
      id: 999,
      ...comment,
    },
    issue: { number: 9, pull_request: { url: 'x' }, state: 'open', ...issue },
    repository: { ...REPO },
    sender: { ...SENDER },
    ...over,
  };
}

describe('normalizePrFeedbackEvent: pull_request_review', () => {
  it('maps a review requesting changes by a person, the body as notes', () => {
    const event = normalizePrFeedbackEvent('pull_request_review', reviewBody());
    expect(event).toMatchObject({
      facts: {
        eventId: '777',
        eventKind: 'review',
        headRef: 'auto/prfb-9-1',
        notes: 'Please handle the null case.',
        prNumber: 9,
        senderId: '42',
        trigger: 'changes_requested',
      },
      org: 'acme',
      repoName: 'api',
      repositoryId: 7,
      type: 'feedback',
    });
  });

  it('maps an approved review that carries the command, notes from the command', () => {
    const event = normalizePrFeedbackEvent(
      'pull_request_review',
      reviewBody({}, { body: 'lgtm\n/auto-swe fix the typo too', state: 'approved' })
    );
    expect(event).toMatchObject({
      facts: { notes: 'the typo too', trigger: 'command' },
      type: 'feedback',
    });
  });

  it.each([
    ['another action', reviewBody({ action: 'edited' })],
    ['a closed pull request', reviewBody({ pull_request: { ...PR, state: 'closed' } })],
    ['a bot', reviewBody({ sender: { id: 1, login: 'auto-swe[bot]', type: 'Bot' } })],
    ['a fork head', reviewBody({ pull_request: { ...PR, head: { ref: 'x', repo: { id: 8 } } } })],
    ['a deleted fork', reviewBody({ pull_request: { ...PR, head: { ref: 'x', repo: null } } })],
    [
      'a review without the command and not requesting changes',
      reviewBody({}, { state: 'commented' }),
    ],
  ])('ignores %s', (_name, payload) => {
    expect(normalizePrFeedbackEvent('pull_request_review', payload).type).toBe('ignored');
  });

  it('is unrecognized for another shape', () => {
    expect(normalizePrFeedbackEvent('pull_request_review', { zen: 'hi' }).type).toBe(
      'unrecognized'
    );
  });
});

describe('normalizePrFeedbackEvent: pull_request_review_comment', () => {
  it('maps an inline comment carrying the command', () => {
    const event = normalizePrFeedbackEvent('pull_request_review_comment', reviewCommentBody());
    expect(event).toMatchObject({
      facts: {
        eventId: '888',
        eventKind: 'review_comment',
        headRef: 'auto/prfb-9-1',
        notes: 'the flaky test',
        prNumber: 9,
        trigger: 'command',
      },
      type: 'feedback',
    });
  });

  it.each([
    ['another action', reviewCommentBody({ action: 'deleted' })],
    ['no command', reviewCommentBody({}, { body: 'nice catch' })],
    ['a bot', reviewCommentBody({ sender: { id: 1, login: 'dependabot[bot]', type: 'Bot' } })],
    [
      'a fork head',
      reviewCommentBody({ pull_request: { ...PR, head: { ref: 'x', repo: { id: 8 } } } }),
    ],
  ])('ignores %s', (_name, payload) => {
    expect(normalizePrFeedbackEvent('pull_request_review_comment', payload).type).toBe('ignored');
  });
});

describe('normalizePrFeedbackEvent: issue_comment', () => {
  it('maps a discussion comment carrying the command, headRef still unset', () => {
    const event = normalizePrFeedbackEvent('issue_comment', issueCommentBody());
    expect(event).toMatchObject({
      facts: {
        eventId: '999',
        eventKind: 'issue_comment',
        notes: 'while you are there, update the test',
        prNumber: 9,
        trigger: 'command',
      },
      repositoryId: 7,
      type: 'feedback',
    });
    if (event.type === 'feedback') {
      expect(event.facts.headRef).toBeUndefined();
    }
  });

  it.each([
    ['another action', issueCommentBody({ action: 'edited' })],
    ['not on a pull request', issueCommentBody({}, { pull_request: undefined })],
    ['a closed pull request', issueCommentBody({}, { state: 'closed' })],
    ['a bot', issueCommentBody({ sender: { id: 1, login: 'x[bot]', type: 'Bot' } })],
    ['no command', issueCommentBody({}, {}, { body: 'thanks' })],
  ])('ignores %s', (_name, payload) => {
    expect(normalizePrFeedbackEvent('issue_comment', payload).type).toBe('ignored');
  });
});
