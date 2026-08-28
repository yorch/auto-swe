import { describe, expect, it, vi } from 'vitest';
import { postSlackMessage } from './slack.js';

describe('postSlackMessage', () => {
  it('posts a message to a channel', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ channel: 'C123', ok: true, ts: '1234.5678' }),
      ok: true,
    });

    const result = await postSlackMessage(
      { apiToken: 'xoxb-test' },
      {
        channelId: 'C123',
        text: 'Hello team',
      }
    );

    expect(result).toEqual({ channelId: 'C123', ts: '1234.5678' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        body: JSON.stringify({ channel: 'C123', text: 'Hello team' }),
        headers: expect.objectContaining({ Authorization: 'Bearer xoxb-test' }),
        method: 'POST',
      })
    );
  });

  it('throws a non-retryable error on Slack API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ error: 'channel_not_found', ok: false }),
      ok: true,
    });

    await expect(
      postSlackMessage({ apiToken: 'xoxb-test' }, { channelId: 'C999', text: 'Hello' })
    ).rejects.toThrow(/channel_not_found/);
  });

  it('throws a transient error on rate limit', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: async () => ({ error: 'rate_limited', ok: false }),
      ok: true,
    });

    await expect(
      postSlackMessage({ apiToken: 'xoxb-test' }, { channelId: 'C123', text: 'Hello' })
    ).rejects.toThrow(/rate limited/);
  });
});
