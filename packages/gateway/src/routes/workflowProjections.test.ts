import { describe, expect, it } from 'vitest';
import { projectRunProvenance, projectRunSummary } from './workflowProjections.js';

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
