import { describe, expect, it } from 'vitest';
import {
  projectRunProvenance,
  projectRunSummary,
  projectWorkRequest,
} from './workflowProjections.js';

const BASE = {
  costUsdAccrued: 0,
  endedAt: null,
  id: 'run-1',
  outcomeDomain: null,
  outcomeType: null,
  startedAt: new Date('2026-01-01T00:00:00Z'),
  status: 'RUNNING',
  templateId: 't-1',
  templateVersion: 1,
  workflowId: 'wf-1',
  workRequest: null,
};

describe('projectRunProvenance', () => {
  it('is null throughout for a run that predates provenance', () => {
    expect(projectRunProvenance({})).toEqual({
      initiatedBy: null,
      initiatedByService: null,
      rerunOfRunId: null,
      trigger: null,
      triggerRefId: null,
    });
  });

  it('names a user initiator by id, name and email, and nothing else', () => {
    const out = projectRunProvenance({
      initiatedBy: { email: 'a@corp.test', id: 'u-1', name: 'Ada', role: 'ADMIN' } as never,
      rerunOfRunId: 'r-0',
      trigger: 'automation',
      triggerRefId: 'auto-1',
    });
    expect(out).toEqual({
      initiatedBy: { email: 'a@corp.test', id: 'u-1', name: 'Ada' },
      initiatedByService: null,
      rerunOfRunId: 'r-0',
      trigger: 'automation',
      triggerRefId: 'auto-1',
    });
  });

  it('names a service principal by id and name', () => {
    expect(
      projectRunProvenance({ initiatedByService: { id: 'sp-1', name: 'ci-bot' } })
        .initiatedByService
    ).toEqual({ id: 'sp-1', name: 'ci-bot' });
  });

  it('reports an unrecognised stored trigger as null', () => {
    expect(projectRunProvenance({ trigger: 'something-new' }).trigger).toBeNull();
  });
});

describe('projectRunSummary provenance', () => {
  it('adds the provenance fields without changing isMine, which stays keyed on launchedById', () => {
    const run = {
      ...BASE,
      initiatedBy: { email: 'a@corp.test', id: 'initiator', name: 'Ada' },
      launchedById: 'launcher',
      trigger: 'work-request',
    };
    const asLauncher = projectRunSummary(run, 'launcher');
    expect(asLauncher.isMine).toBe(true);
    expect(asLauncher.initiatedBy?.id).toBe('initiator');
    expect(projectRunSummary(run, 'initiator').isMine).toBe(false);
    expect(projectRunSummary(run).isMine).toBe(false);
    expect(asLauncher).not.toHaveProperty('launchedById');
  });
});

describe('projectWorkRequest title', () => {
  const WR = { description: '', externalTicketId: 'T-1', id: 'wr-1' };

  it('prefers the title column over the payload label', () => {
    const out = projectWorkRequest({
      ...WR,
      requestPayload: JSON.stringify({ label: 'From payload' }),
      title: '  From column  ',
    });
    expect(out?.title).toBe('From column');
  });

  it('returns the column title as stored: the database trigger owns its cap', () => {
    // 200 astral characters are 400 UTF-16 code units; a re-slice would cut them in half.
    const stored = '😀'.repeat(200);
    const out = projectWorkRequest({ ...WR, requestPayload: '{}', title: stored });
    expect(out?.title).toBe(stored);
  });

  it('still caps the payload-label fallback at 200 characters', () => {
    const out = projectWorkRequest({
      ...WR,
      requestPayload: JSON.stringify({ label: 'x'.repeat(250) }),
      title: null,
    });
    expect(out?.title).toHaveLength(200);
  });

  it('falls back to the payload label when the column is blank', () => {
    const out = projectWorkRequest({
      ...WR,
      requestPayload: JSON.stringify({ label: '  Payload label  ' }),
      title: '   ',
    });
    expect(out?.title).toBe('Payload label');
  });

  it('falls back to the payload label when the column is null or not selected', () => {
    const payload = JSON.stringify({ label: 'Payload label' });
    expect(projectWorkRequest({ ...WR, requestPayload: payload, title: null })?.title).toBe(
      'Payload label'
    );
    expect(projectWorkRequest({ ...WR, requestPayload: payload })?.title).toBe('Payload label');
  });

  it('has no title when both the column and the payload label are missing', () => {
    const out = projectWorkRequest({ ...WR, requestPayload: 'not json', title: null });
    expect(out).toEqual({ description: '', externalTicketId: 'T-1', id: 'wr-1' });
    expect(out).not.toHaveProperty('title');
  });

  it('returns null for a run with no work request', () => {
    expect(projectWorkRequest(null)).toBeNull();
  });
});
