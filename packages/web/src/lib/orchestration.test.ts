import { ORCHESTRATION_REFUSAL_CODES } from '@auto-swe/shared/lib/orchestration';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  buildOrchestrateBody,
  countdown,
  describeOrchestrationError,
  elapsedMs,
  finishedReason,
  httpsUrl,
  isChildRunning,
  isOrchestrationLive,
  type OrchestrateFormValues,
  REFUSAL_MESSAGES,
  validateOrchestrateForm,
} from './orchestration';

const VALID: OrchestrateFormValues = {
  allowlist: ['researcher'],
  budgetTier: 'STANDARD',
  connectionIds: [],
  deliveryDefault: 'none',
  repoId: '',
  task: 'Investigate',
  teamId: 'team-1',
};

describe('refusal codes', () => {
  it('has plain-language wording for every code the API can answer with', () => {
    for (const code of ORCHESTRATION_REFUSAL_CODES) {
      expect(REFUSAL_MESSAGES[code], code).toMatch(/\S{3,}/);
      expect(REFUSAL_MESSAGES[code], code).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
    }
    expect(Object.keys(REFUSAL_MESSAGES).sort()).toEqual([...ORCHESTRATION_REFUSAL_CODES].sort());
  });

  it('maps a known code to our wording and keeps the gateway text for the rest', () => {
    const known = new ApiError('raw text', 409, 'SCOPE_OVERLAP');
    expect(describeOrchestrationError(known)).toBe(REFUSAL_MESSAGES.SCOPE_OVERLAP);
    expect(describeOrchestrationError(new ApiError('Something broke', 500, 'WHO_KNOWS'))).toBe(
      'Something broke'
    );
    expect(describeOrchestrationError('nope')).toBe('The request failed.');
  });
});

describe('status helpers', () => {
  it('treats only active and waiting orchestrations as live', () => {
    expect(isOrchestrationLive('ACTIVE')).toBe(true);
    expect(isOrchestrationLive('WAITING')).toBe(true);
    for (const s of ['COMPLETED', 'CANCELLED', 'FAILED', undefined] as const) {
      expect(isOrchestrationLive(s)).toBe(false);
    }
    expect(isChildRunning('RUNNING')).toBe(true);
    expect(isChildRunning('COMPLETED')).toBe(false);
  });

  it('explains why a finished orchestration takes no messages', () => {
    expect(finishedReason('ACTIVE')).toBeNull();
    expect(finishedReason('CANCELLED')).toMatch(/cancelled/);
    expect(finishedReason('FAILED')).toMatch(/failed/);
    expect(finishedReason('COMPLETED')).toMatch(/ended/);
  });
});

describe('httpsUrl', () => {
  it('links only https', () => {
    expect(httpsUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1');
    for (const bad of [
      'http://x.test',
      'javascript:alert(1)',
      'data:text/html,x',
      'nope',
      '',
      null,
    ]) {
      expect(httpsUrl(bad)).toBeNull();
    }
  });
});

describe('time helpers', () => {
  it('counts down and stops at expiry', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(countdown('2026-01-01T00:09:05Z', now)).toBe('9:05');
    expect(countdown('2026-01-01T01:00:00Z', now)).toBe('1:00:00');
    expect(countdown('2026-01-01T00:00:00Z', now)).toBeNull();
    expect(countdown('garbage', now)).toBeNull();
  });

  it('measures elapsed time to the finish, or to now while running', () => {
    expect(elapsedMs('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 0)).toBe(60_000);
    expect(elapsedMs('2026-01-01T00:00:00Z', null, Date.parse('2026-01-01T00:00:30Z'))).toBe(
      30_000
    );
  });
});

describe('launch form', () => {
  it('accepts a repository-less launch with a team', () => {
    expect(validateOrchestrateForm(VALID)).toEqual({});
  });

  it('requires a team when there is no repository', () => {
    expect(validateOrchestrateForm({ ...VALID, teamId: '' }).teamId).toBeTruthy();
    expect(
      validateOrchestrateForm({ ...VALID, repoId: 'repo-1', teamId: '' }).teamId
    ).toBeUndefined();
  });

  it('requires a task and a non-empty allowlist', () => {
    expect(validateOrchestrateForm({ ...VALID, task: '  ' }).task).toBeTruthy();
    expect(validateOrchestrateForm({ ...VALID, allowlist: [] }).allowlist).toBeTruthy();
    expect(validateOrchestrateForm({ ...VALID, task: 'x'.repeat(20_001) }).task).toBeTruthy();
    expect(
      validateOrchestrateForm({
        ...VALID,
        allowlist: Array.from({ length: 21 }, (_, i) => `a${i}`),
      }).allowlist
    ).toBeTruthy();
  });

  it('builds a body that names the team only without a repository, and forces no delivery', () => {
    expect(buildOrchestrateBody({ ...VALID, deliveryDefault: 'draft_pr' })).toEqual({
      allowlist: ['researcher'],
      budgetTier: 'STANDARD',
      deliveryDefault: 'none',
      task: 'Investigate',
      teamId: 'team-1',
    });
    expect(
      buildOrchestrateBody({
        ...VALID,
        connectionIds: ['c1'],
        deliveryDefault: 'draft_pr',
        repoId: 'r1',
      })
    ).toEqual({
      allowlist: ['researcher'],
      budgetTier: 'STANDARD',
      connectionIds: ['c1'],
      deliveryDefault: 'draft_pr',
      repoId: 'r1',
      task: 'Investigate',
    });
  });
});
