import {
  CampaignAttemptOutcomeSchema,
  CampaignBlockedReasonSchema,
  CampaignCreateBodySchema,
  CampaignGateSchema,
  CampaignPlanSchema,
  CampaignScopeKindSchema,
  type CampaignTargetDto,
  CampaignTargetPathSchema,
  CampaignVerificationSchema,
  CampaignWorkflowKindSchema,
} from '@auto-swe/shared/lib/campaignApi';
import {
  CAMPAIGN_PAUSED_REASONS,
  CAMPAIGN_STATE_VALUES,
  CAMPAIGN_TARGET_STATE_VALUES,
} from '@auto-swe/shared/lib/campaignState';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_OUTCOME_LABELS,
  BLOCKED_KIND_LABELS,
  breakdownText,
  CAMPAIGN_FORM_LIMITS,
  CAMPAIGN_STATE_LABELS,
  CAMPAIGN_STATE_TONES,
  campaignProgress,
  campaignStateLabel,
  canRemoveTarget,
  canRetryTarget,
  GATE_LABELS,
  groupTargets,
  latestAttempt,
  PATH_LABELS,
  PAUSED_REASON_LABELS,
  PAUSED_REASON_TEXT,
  PLAN_LABELS,
  PULL_REQUEST_STATUS_LABELS,
  RECIPE_OPTIONS,
  SCOPE_KIND_LABELS,
  TARGET_STATE_LABELS,
  TARGET_STATE_TONES,
  targetStateLabel,
  VERIFICATION_LABELS,
  WORKFLOW_KIND_LABELS,
} from './campaignDisplay';

/** Every value of an enum must read as words: a value added in shared code fails here. */
function expectLabelled(values: readonly string[], table: Record<string, string>, what: string) {
  for (const value of values) {
    expect(table[value], `${what} ${value} has no label`).toBeTruthy();
    expect(table[value]?.trim().length, `${what} ${value} has an empty label`).toBeGreaterThan(0);
  }
  expect(Object.keys(table).sort(), `${what} table has a stale value`).toEqual([...values].sort());
}

describe('label tables cover every enum value', () => {
  it('campaign states, including the legacy ones', () => {
    expectLabelled(CAMPAIGN_STATE_VALUES, CAMPAIGN_STATE_LABELS, 'campaign state');
    expectLabelled(CAMPAIGN_STATE_VALUES, CAMPAIGN_STATE_TONES, 'campaign state tone');
    for (const state of ['RUNNING', 'COMPLETED_WITH_FAILURES', 'FAILED_TO_START'] as const) {
      expect(campaignStateLabel(state)).toBeTruthy();
    }
  });

  it('target states, including the retired ones', () => {
    expectLabelled(CAMPAIGN_TARGET_STATE_VALUES, TARGET_STATE_LABELS, 'target state');
    expectLabelled(CAMPAIGN_TARGET_STATE_VALUES, TARGET_STATE_TONES, 'target state tone');
  });

  it('paused reasons, blocked kinds, attempt outcomes, paths and verifications', () => {
    expectLabelled(CAMPAIGN_PAUSED_REASONS, PAUSED_REASON_TEXT, 'paused reason');
    expectLabelled(CAMPAIGN_PAUSED_REASONS, PAUSED_REASON_LABELS, 'paused reason label');
    expectLabelled(
      CampaignBlockedReasonSchema.shape.kind.options,
      BLOCKED_KIND_LABELS,
      'blocked kind'
    );
    expectLabelled(CampaignAttemptOutcomeSchema.options, ATTEMPT_OUTCOME_LABELS, 'attempt outcome');
    expectLabelled(CampaignTargetPathSchema.options, PATH_LABELS, 'target path');
    expectLabelled(CampaignVerificationSchema.options, VERIFICATION_LABELS, 'verification');
  });

  it('pull request statuses, plans, gates, scopes and workflow kinds', () => {
    expectLabelled(['OPEN', 'MERGED', 'CLOSED'], PULL_REQUEST_STATUS_LABELS, 'pull request status');
    expectLabelled(CampaignPlanSchema.options, PLAN_LABELS, 'plan');
    expectLabelled(CampaignGateSchema.options, GATE_LABELS, 'gate');
    expectLabelled(CampaignScopeKindSchema.options, SCOPE_KIND_LABELS, 'scope kind');
    expectLabelled(CampaignWorkflowKindSchema.options, WORKFLOW_KIND_LABELS, 'workflow kind');
  });

  it('reads a retired target state as the state that replaced it', () => {
    expect(targetStateLabel('FAILED')).toBe(TARGET_STATE_LABELS.NEEDS_ATTENTION);
    expect(targetStateLabel('NOT_AFFECTED')).toBe(TARGET_STATE_LABELS.SATISFIED);
    expect(targetStateLabel('PR_OPENED')).toBe('In review');
  });
});

describe('recipes', () => {
  it('offers @2 recipes with the discovery explanation and @1 with the limit', () => {
    const byValue = new Map<string, string>(RECIPE_OPTIONS.map((o) => [o.value, o.description]));
    expect(byValue.get('npm-dependency@2')).toMatch(/find repositories/);
    expect(byValue.get('go-module@2')).toMatch(/confirm that a merge fixed/);
    expect(byValue.get('npm-dependency@1')).toMatch(/no discovery/);
    expect(byValue.get('go-module@1')).toMatch(/no verification of merges/);
  });
});

describe('form limits', () => {
  const base = {
    description: 'Raise lodash',
    name: 'Lodash',
    ownerTeamId: '0b1c2d3e-0000-4000-8000-000000000001',
    repoIds: ['0b1c2d3e-0000-4000-8000-000000000002'],
  };
  const fields = [
    'maxOpenPullRequests',
    'staleAfterDays',
    'rescanIntervalHours',
    'lifetimeDays',
  ] as const;

  it('agree with the wire schema at both ends', () => {
    for (const field of fields) {
      const { max, min } = CAMPAIGN_FORM_LIMITS[field];
      expect(CampaignCreateBodySchema.safeParse({ ...base, [field]: min }).success).toBe(true);
      expect(CampaignCreateBodySchema.safeParse({ ...base, [field]: max }).success).toBe(true);
      expect(CampaignCreateBodySchema.safeParse({ ...base, [field]: min - 1 }).success).toBe(false);
      expect(CampaignCreateBodySchema.safeParse({ ...base, [field]: max + 1 }).success).toBe(false);
    }
    const { max } = CAMPAIGN_FORM_LIMITS.budgetUsd;
    expect(CampaignCreateBodySchema.safeParse({ ...base, budgetUsd: max }).success).toBe(true);
    expect(CampaignCreateBodySchema.safeParse({ ...base, budgetUsd: max + 1 }).success).toBe(false);
    expect(CampaignCreateBodySchema.safeParse({ ...base, budgetUsd: 0 }).success).toBe(false);
  });
});

const COUNTS = {
  blocked: 1,
  cancelled: 0,
  merged: 1,
  needsAttention: 2,
  pending: 3,
  prOpened: 2,
  running: 1,
  satisfied: 4,
  skipped: 1,
  total: 15,
};

describe('progress', () => {
  it('is satisfied over total, with the people-needed count beside it', () => {
    expect(campaignProgress(COUNTS)).toEqual({
      needsAttention: 2,
      percent: 27,
      satisfied: 4,
      total: 15,
    });
    expect(campaignProgress({ ...COUNTS, total: 0 }).percent).toBe(0);
  });

  it('lists what is left apart from satisfied and needing a person', () => {
    expect(breakdownText(COUNTS)).toBe(
      '2 in review · 1 merged, checking · 1 running · 1 blocked · 3 not started · 1 skipped'
    );
    expect(breakdownText({ ...COUNTS, blocked: 0, merged: 0, prOpened: 0, running: 0 })).toBe(
      '3 not started · 1 skipped'
    );
  });
});

function target(over: Partial<CampaignTargetDto> & Pick<CampaignTargetDto, 'id' | 'state'>) {
  return {
    attempts: [],
    blockedReason: null,
    brief: null,
    childWorkflowId: null,
    connectionId: null,
    delivery: null,
    dependsOn: [],
    evidence: null,
    failureReason: null,
    finishedAt: null,
    lastCheckedAt: null,
    lastCheckedSha: null,
    liveStatus: null,
    path: null,
    position: 0,
    prNumber: null,
    prUrl: null,
    regressions: 0,
    repoLabel: `acme/${over.id}`,
    staleSince: null,
    startedAt: null,
    verification: null,
    ...over,
  } satisfies CampaignTargetDto;
}

describe('groupTargets', () => {
  it('orders groups by what the reader needs and keeps launch order inside them', () => {
    const groups = groupTargets([
      target({ id: 'done', position: 0, state: 'SATISFIED' }),
      target({ id: 'skip', position: 1, state: 'SKIPPED' }),
      target({ id: 'run', position: 2, state: 'RUNNING' }),
      target({ id: 'wait', position: 3, state: 'BLOCKED' }),
      target({ id: 'review', position: 4, state: 'PR_OPENED' }),
      target({ id: 'merged', position: 5, state: 'MERGED' }),
      target({ id: 'help', position: 6, state: 'NEEDS_ATTENTION' }),
      target({ id: 'old-fail', position: 7, state: 'FAILED' }),
      target({ id: 'old-none', position: 8, state: 'NOT_AFFECTED' }),
      target({ id: 'cancelled', position: 9, state: 'CANCELLED' }),
    ]);
    expect(groups.map((g) => [g.id, g.targets.map((t) => t.id)])).toEqual([
      ['attention', ['help', 'old-fail']],
      ['review', ['review', 'merged']],
      ['progress', ['run', 'wait']],
      ['satisfied', ['done', 'old-none']],
      ['closed', ['skip', 'cancelled']],
    ]);
  });

  it('leaves out groups with no target', () => {
    expect(groupTargets([target({ id: 'a', state: 'PENDING' })]).map((g) => g.id)).toEqual([
      'progress',
    ]);
    expect(groupTargets([])).toEqual([]);
  });
});

describe('target helpers', () => {
  it('finds the latest attempt by number, not by position', () => {
    const attempt = (n: number) => ({
      childWorkflowId: null,
      failureReason: null,
      finishedAt: null,
      id: `a${n}`,
      n,
      outcome: null,
      path: null,
      runId: null,
      startedAt: '2026-01-01T00:00:00Z',
      verification: null,
    });
    expect(
      latestAttempt(
        target({ attempts: [attempt(2), attempt(3), attempt(1)], id: 't', state: 'RUNNING' })
      )?.n
    ).toBe(3);
    expect(latestAttempt(target({ id: 't', state: 'PENDING' }))).toBeNull();
  });

  it('offers retry only for a target that needs a person, and remove for one not finished or running', () => {
    const states = CAMPAIGN_TARGET_STATE_VALUES.map((state) => target({ id: state, state }));
    expect(states.filter(canRetryTarget).map((t) => t.state)).toEqual([
      'NEEDS_ATTENTION',
      'FAILED',
    ]);
    expect(states.filter(canRemoveTarget).map((t) => t.state)).toEqual([
      'PENDING',
      'BLOCKED',
      'PR_OPENED',
      'MERGED',
      'NEEDS_ATTENTION',
      'FAILED',
    ]);
  });
});
