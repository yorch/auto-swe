import { beforeEach, describe, expect, it, vi } from 'vitest';

const decryptSecret = vi.fn((_secret: unknown) => 'routing-key');
vi.mock('@auto-swe/shared/lib/crypto', () => ({
  decryptSecret: (secret: unknown) => decryptSecret(secret),
}));

import {
  mergeChangeEvent,
  PAGERDUTY_CHANGE_EVENTS_URL,
  sendMergeChangeEvent,
} from './pagerdutyChangeEvents.js';

const pr = {
  mergedAt: new Date('2026-11-12T10:00:00.000Z'),
  org: 'acme',
  prNumber: 7,
  prUrl: 'https://github.com/acme/api/pull/7',
  repoName: 'api',
  ticketId: 'PROJ-1',
  title: 'Fix the retry loop',
};

const row = {
  apiKeyAuthTag: new Uint8Array([1]),
  apiKeyCiphertext: new Uint8Array([2]),
  apiKeyNonce: new Uint8Array([3]),
  apiKeyVersion: 1,
  isActive: true,
  type: 'pagerduty_events',
};

const findUnique = vi.fn();
const prisma = { connection: { findUnique } } as never;
const log = { warn: vi.fn() };
const fetchMock = vi.fn();

beforeEach(() => {
  findUnique.mockReset();
  fetchMock.mockReset();
  log.warn.mockReset();
});

describe('mergeChangeEvent', () => {
  it('describes the merge with a link to the pull request', () => {
    expect(mergeChangeEvent(pr)).toEqual({
      links: [{ href: 'https://github.com/acme/api/pull/7', text: 'Pull request #7' }],
      payload: {
        custom_details: { pull_request: 7, repository: 'acme/api', ticket: 'PROJ-1' },
        source: 'auto-swe',
        summary: 'Merged acme/api#7: Fix the retry loop',
        timestamp: '2026-11-12T10:00:00.000Z',
      },
    });
  });

  it("keeps the summary within PagerDuty's 1024 characters", () => {
    const event = mergeChangeEvent({ ...pr, ticketId: null, title: 'x'.repeat(2000) });
    expect(event.payload.summary).toHaveLength(1024);
    expect(event.payload.custom_details).not.toHaveProperty('ticket');
  });
});

describe('sendMergeChangeEvent', () => {
  it('posts the event with the decrypted routing key', async () => {
    findUnique.mockResolvedValue(row);
    fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
    await expect(sendMergeChangeEvent(prisma, 'pde-1', pr, log, fetchMock)).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PAGERDUTY_CHANGE_EVENTS_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body as string)).toEqual({
      ...mergeChangeEvent(pr),
      routing_key: 'routing-key',
    });
  });

  it('sends nothing without a connection', async () => {
    await expect(sendMergeChangeEvent(prisma, null, pr, log, fetchMock)).resolves.toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['another type', { ...row, type: 'pagerduty' }],
    ['an inactive connection', { ...row, isActive: false }],
    ['no routing key', { ...row, apiKeyCiphertext: null }],
    ['a missing connection', null],
  ])('sends nothing for %s', async (_label, found) => {
    findUnique.mockResolvedValue(found);
    await expect(sendMergeChangeEvent(prisma, 'pde-1', pr, log, fetchMock)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('logs a refused event without throwing', async () => {
    findUnique.mockResolvedValue(row);
    fetchMock.mockResolvedValue(new Response('{}', { status: 400 }));
    await expect(sendMergeChangeEvent(prisma, 'pde-1', pr, log, fetchMock)).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400 }),
      expect.stringContaining('not accepted')
    );
  });

  it.each([
    ['PagerDuty is unreachable', () => fetchMock.mockRejectedValue(new Error('ECONNRESET'))],
    ['the database fails', () => findUnique.mockRejectedValue(new Error('db down'))],
    [
      'the key cannot be decrypted',
      () =>
        decryptSecret.mockImplementationOnce(() => {
          throw new Error('bad key');
        }),
    ],
  ])('never throws when %s', async (_label, arrange) => {
    findUnique.mockResolvedValue(row);
    arrange();
    await expect(sendMergeChangeEvent(prisma, 'pde-1', pr, log, fetchMock)).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
