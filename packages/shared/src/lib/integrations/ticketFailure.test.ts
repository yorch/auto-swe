import { describe, expect, it } from 'vitest';
import {
  isTimeoutError,
  TICKET_FAILURE_CLASSES,
  ticketFailureFromStatus,
} from './ticketFailure.js';

describe('ticketFailureFromStatus', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [503, 'server_error'],
    [400, 'rejected'],
    [422, 'rejected'],
    [418, 'rejected'],
    [302, 'redirect'],
  ])('maps %i to %s', (status, expected) => {
    expect(ticketFailureFromStatus(status)).toBe(expected);
  });

  it('only ever answers with a member of the closed set', () => {
    for (const status of [0, 200, 301, 400, 401, 403, 404, 418, 429, 500, 599]) {
      expect(TICKET_FAILURE_CLASSES).toContain(ticketFailureFromStatus(status));
    }
  });
});

it('has the classes that blame neither the tracker nor access', () => {
  expect(TICKET_FAILURE_CLASSES).toContain('rejected');
  expect(TICKET_FAILURE_CLASSES).toContain('refused');
});

describe('isTimeoutError', () => {
  it('recognises an AbortSignal.timeout rejection, bare or as a cause', () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    expect(isTimeoutError(timeout)).toBe(true);
    expect(isTimeoutError(new TypeError('fetch failed', { cause: timeout }))).toBe(true);
  });

  it('does not take another failure for a timeout', () => {
    expect(isTimeoutError(new TypeError('fetch failed'))).toBe(false);
    expect(isTimeoutError('TimeoutError')).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});
