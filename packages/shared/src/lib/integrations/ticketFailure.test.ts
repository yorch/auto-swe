import { describe, expect, it } from 'vitest';
import {
  isTimeoutError,
  readTrackerWriteback,
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

describe('readTrackerWriteback', () => {
  it.each(['workflow_completed', 'workflow_failed'] as const)(
    'reads the %s failure a run recorded on its snapshot',
    (event) => {
      expect(
        readTrackerWriteback({ result: {}, trackerWriteback: { event, failure: 'forbidden' } })
      ).toEqual({ event, failure: 'forbidden' });
    }
  );

  it('reads a record stored before the event was kept as a workflow_failed one', () => {
    expect(
      readTrackerWriteback({ result: {}, trackerWriteback: { failure: 'forbidden' } })
    ).toEqual({ event: 'workflow_failed', failure: 'forbidden' });
  });

  it('accepts the out_of_scope class', () => {
    expect(
      readTrackerWriteback({
        trackerWriteback: { event: 'workflow_completed', failure: 'out_of_scope' },
      })
    ).toEqual({ event: 'workflow_completed', failure: 'out_of_scope' });
  });

  it.each([
    ['no snapshot', null],
    ['a snapshot that is not an object', 'text'],
    ['a snapshot with no record', { result: {} }],
    ['a record that is not an object', { trackerWriteback: 'forbidden' }],
    ['a record with no failure', { trackerWriteback: {} }],
    ['a failure outside the closed set', { trackerWriteback: { failure: 'boom: 403 <html>' } }],
    ['a failure that is a prototype key', { trackerWriteback: { failure: 'constructor' } }],
    [
      'an event outside the closed set',
      { trackerWriteback: { event: 'ci_failed', failure: 'forbidden' } },
    ],
    [
      'an event that is a prototype key',
      { trackerWriteback: { event: 'constructor', failure: 'forbidden' } },
    ],
    ['an event that is not a string', { trackerWriteback: { event: 1, failure: 'forbidden' } }],
    ['an event that is null', { trackerWriteback: { event: null, failure: 'forbidden' } }],
  ])('answers null for %s', (_label, snapshot) => {
    expect(readTrackerWriteback(snapshot)).toBeNull();
  });
});
