import { describe, expect, it } from 'vitest';
import { normalizeIssueLabeledEvent } from './issueLabeled.js';

function body(over: Record<string, unknown> = {}, issue: Record<string, unknown> = {}) {
  return {
    action: 'labeled',
    issue: {
      body: 'It should return 200.',
      html_url: 'https://github.com/acme/api/issues/9',
      number: 9,
      state: 'open',
      title: 'Add a health check',
      updated_at: '2026-10-01T00:00:00Z',
      ...issue,
    },
    label: { name: 'auto-swe' },
    repository: { full_name: 'acme/api', html_url: 'https://github.com/acme/api' },
    sender: { id: 42, login: 'octocat', type: 'User' },
    ...over,
  };
}

describe('normalizeIssueLabeledEvent', () => {
  it('maps a label added to an open issue by a person', () => {
    expect(normalizeIssueLabeledEvent(body())).toMatchObject({
      facts: { issueNumber: 9, label: 'auto-swe', senderId: '42', senderLogin: 'octocat' },
      org: 'acme',
      repoName: 'api',
      type: 'labeled',
    });
  });

  it.each([
    ['another action', body({ action: 'opened' })],
    ['a closed issue', body({}, { state: 'closed' })],
    ['a pull request', body({}, { pull_request: { url: 'x' } })],
    ['a bot', body({ sender: { id: 1, login: 'auto-swe[bot]', type: 'Bot' } })],
  ])('ignores %s', (_name, payload) => {
    expect(normalizeIssueLabeledEvent(payload).type).toBe('ignored');
  });

  it('bounds the issue text it keeps', () => {
    const event = normalizeIssueLabeledEvent(body({}, { body: 'x'.repeat(10_000) }));
    expect(event.type === 'labeled' && event.facts.body.length).toBe(4_000);
  });

  it('is unrecognized for another shape', () => {
    expect(normalizeIssueLabeledEvent({ zen: 'hi' }).type).toBe('unrecognized');
  });
});
