import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn(() => true);
vi.mock('./activityEvents.js', async (orig) => ({
  ...(await orig<typeof import('./activityEvents.js')>()),
  currentActivityQueue: () => ({ enqueue }),
}));

import { observeSignInResult, recordSignInAudit } from './signInAudit.js';

const db = () =>
  ({
    configAuditLog: { create: vi.fn(async () => ({})) },
    user: { findUnique: vi.fn(async () => ({ id: 'u-1' })) },
    userActivityEvent: { create: vi.fn() },
  }) as never;

beforeEach(() => enqueue.mockClear());

describe('auth events through the activity queue', () => {
  it('never dedupes a failed sign-in, so a burst stays countable', async () => {
    await observeSignInResult(db(), {
      body: { email: 'a@example.com' },
      context: {
        returned: {
          body: { code: 'INVALID_EMAIL_OR_PASSWORD' },
          name: 'APIError',
          statusCode: 401,
        },
      },
      path: '/sign-in/email',
    });
    expect(enqueue).toHaveBeenCalledTimes(1);
    const calls = enqueue.mock.calls as unknown as Array<[{ kind: string }, unknown]>;
    expect(calls[0]?.[0].kind).toBe('sign_in_failed');
    expect(calls[0]?.[1]).toBeUndefined();
  });

  it('still dedupes a sign-in', async () => {
    await recordSignInAudit(db(), { id: 's', userId: 'u-1' }, { path: '/sign-in/email' });
    const calls = enqueue.mock.calls as unknown as Array<
      [{ kind: string }, { key: string } | undefined]
    >;
    expect(calls[0]?.[0].kind).toBe('sign_in');
    expect(calls[0]?.[1]?.key).toMatch(/^sign_in\|u-1\|/);
  });
});
