import { describe, expect, it } from 'vitest';
import {
  type CiCheckRun,
  type CiCombinedStatus,
  normalizeCiStatus,
  pickLogsUrl,
} from './ciStatus.js';

const noStatus: CiCombinedStatus = { state: 'pending', totalCount: 0 };
const successStatus: CiCombinedStatus = { state: 'success', totalCount: 1 };

const run = (status: string, conclusion: string | null, htmlUrl?: string): CiCheckRun => ({
  conclusion,
  htmlUrl,
  status,
});

describe('normalizeCiStatus', () => {
  it('returns "none" when there are no checks and no statuses', () => {
    expect(normalizeCiStatus([], noStatus)).toBe('none');
  });

  it('returns "passed" when all check-runs succeeded and combined status is success', () => {
    expect(normalizeCiStatus([run('completed', 'success')], successStatus)).toBe('passed');
  });

  it('treats neutral and skipped conclusions as not-failed', () => {
    expect(
      normalizeCiStatus([run('completed', 'neutral'), run('completed', 'skipped')], noStatus)
    ).toBe('passed');
  });

  it('returns "pending" while a check-run is still in progress', () => {
    expect(normalizeCiStatus([run('in_progress', null)], noStatus)).toBe('pending');
  });

  it('returns "pending" when combined status is pending with statuses present', () => {
    expect(normalizeCiStatus([], { state: 'pending', totalCount: 2 })).toBe('pending');
  });

  it('returns "failed" when any check-run concluded failure', () => {
    expect(
      normalizeCiStatus([run('completed', 'success'), run('completed', 'failure')], successStatus)
    ).toBe('failed');
  });

  it.each([
    'cancelled',
    'timed_out',
    'action_required',
    'stale',
  ])('treats conclusion "%s" as failed', (conclusion) => {
    expect(normalizeCiStatus([run('completed', conclusion)], noStatus)).toBe('failed');
  });

  it('returns "failed" when combined status state is failure or error', () => {
    expect(normalizeCiStatus([], { state: 'failure', totalCount: 1 })).toBe('failed');
    expect(normalizeCiStatus([], { state: 'error', totalCount: 1 })).toBe('failed');
  });

  it('prioritizes failure over pending', () => {
    expect(
      normalizeCiStatus([run('in_progress', null), run('completed', 'failure')], noStatus)
    ).toBe('failed');
  });
});

describe('pickLogsUrl', () => {
  it('returns the first failed check-run URL', () => {
    expect(pickLogsUrl([run('completed', 'failure', 'https://ci/run/1')], noStatus)).toBe(
      'https://ci/run/1'
    );
  });

  it('falls back to the combined status target URL', () => {
    expect(
      pickLogsUrl([], { state: 'failure', targetUrl: 'https://ci/status', totalCount: 1 })
    ).toBe('https://ci/status');
  });

  it('returns undefined when nothing failed', () => {
    expect(pickLogsUrl([run('completed', 'success')], successStatus)).toBeUndefined();
  });
});
