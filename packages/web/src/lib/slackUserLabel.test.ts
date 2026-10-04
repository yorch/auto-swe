import { describe, expect, it } from 'vitest';
import { emailsBySlackId, slackUserLabel } from './slackUserLabel';

describe('slackUserLabel', () => {
  const map = emailsBySlackId([
    { email: 'a@example.com', slackId: 'U1' },
    { email: 'b@example.com', slackId: null },
  ]);

  it('shows the linked account email', () => {
    expect(slackUserLabel(map, 'U1')).toBe('a@example.com');
  });

  it('labels an unlinked Slack ID rather than showing it bare', () => {
    expect(slackUserLabel(map, 'U9')).toBe('Slack user U9');
  });

  it('reads a missing user as the system', () => {
    expect(slackUserLabel(map, null)).toBe('System');
  });
});
