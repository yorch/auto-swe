import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchZendeskTicket, postZendeskComment } from './zendesk.js';

describe('zendesk connector', () => {
  const connection = {
    apiToken: 'secret-token',
    config: { email: 'agent@example.com', subdomain: 'example' },
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fetches a ticket', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        ticket: { description: 'Help', id: 42, status: 'open', subject: 'Problem' },
      }),
      ok: true,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchZendeskTicket(connection, '42');
    expect(result.ticket.id).toBe(42);
  });

  it('posts a comment', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ ticket: { id: 42 } }),
      ok: true,
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await postZendeskComment(connection, '42', {
      body: 'Here is the update.',
      public: false,
    });
    expect(result.ticketId).toBe('42');
    expect(result.comment.body).toBe('Here is the update.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the subdomain is missing', async () => {
    await expect(fetchZendeskTicket({ apiToken: 'x', config: {} }, '42')).rejects.toThrow(
      'missing subdomain'
    );
  });

  it('throws on authentication failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchZendeskTicket(connection, '42')).rejects.toThrow('authentication failed');
  });
});
