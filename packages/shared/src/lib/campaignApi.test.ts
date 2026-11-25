import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_REFUSAL_CODES,
  CampaignAddTargetsBodySchema,
  CampaignCreateBodySchema,
  CampaignDetailDtoSchema,
  CampaignRefusalSchema,
  CampaignTargetDtoSchema,
  isCampaignRefusalCode,
} from './campaignApi.js';
import { countTargets } from './campaignState.js';

const UUID = '0b1c2d3e-0000-4000-8000-000000000001';
const UUID2 = '0b1c2d3e-0000-4000-8000-000000000002';

const legacyBody = {
  description: 'Upgrade lodash',
  name: 'lodash',
  ownerTeamId: UUID,
  recipe: { params: { package: 'lodash' }, ref: 'npm-dependency@1' },
  repoIds: [UUID2],
};

describe('CampaignCreateBodySchema', () => {
  it('still accepts the body the endpoint always took', () => {
    expect(CampaignCreateBodySchema.safeParse(legacyBody).success).toBe(true);
  });

  it('accepts the reconciler fields', () => {
    const r = CampaignCreateBodySchema.safeParse({
      ...legacyBody,
      budgetUsd: 50,
      gate: 'MERGED',
      lifetimeDays: 60,
      maxOpenPullRequests: 5,
      plan: 'PLANNED',
      rescanIntervalHours: 24,
      scope: { id: UUID, kind: 'TEAM' },
      staleAfterDays: 7,
    });
    expect(r.success).toBe(true);
  });

  it('needs a team id for a TEAM scope but not for an ORG scope', () => {
    expect(
      CampaignCreateBodySchema.safeParse({ ...legacyBody, scope: { kind: 'TEAM' } }).success
    ).toBe(false);
    expect(
      CampaignCreateBodySchema.safeParse({ ...legacyBody, scope: { kind: 'ORG' } }).success
    ).toBe(true);
  });

  it('refuses out-of-range values, duplicate repositories and control characters', () => {
    for (const over of [
      { maxOpenPullRequests: 0 },
      { staleAfterDays: 0 },
      { rescanIntervalHours: 0 },
      { rescanIntervalHours: 721 },
      { budgetUsd: -1 },
      { lifetimeDays: 400 },
      { plan: 'OTHER' },
      { gate: 'CLOSED' },
      { repoIds: [UUID2, UUID2] },
      { description: 'bad\u0000text' },
    ]) {
      expect(CampaignCreateBodySchema.safeParse({ ...legacyBody, ...over }).success).toBe(false);
    }
  });
});

describe('response schemas', () => {
  const target = {
    attempts: [
      {
        childWorkflowId: 'campaign-x-y',
        failureReason: null,
        finishedAt: null,
        id: UUID,
        n: 1,
        outcome: null,
        path: null,
        runId: null,
        startedAt: '2026-11-25T12:00:00.000Z',
        verification: null,
      },
    ],
    blockedReason: null,
    brief: null,
    childWorkflowId: 'campaign-x-y',
    connectionId: UUID2,
    delivery: null,
    dependsOn: [],
    evidence: { kind: 'initial' },
    failureReason: null,
    finishedAt: null,
    id: UUID,
    lastCheckedAt: null,
    lastCheckedSha: null,
    liveStatus: null,
    path: null,
    position: 0,
    prNumber: null,
    prUrl: null,
    regressions: 0,
    repoLabel: 'org/repo',
    staleSince: null,
    startedAt: null,
    state: 'NEEDS_ATTENTION',
    verification: null,
  };

  it('parses a target in every state, including the retired ones', () => {
    for (const state of ['PENDING', 'BLOCKED', 'SATISFIED', 'NOT_AFFECTED', 'FAILED']) {
      expect(CampaignTargetDtoSchema.safeParse({ ...target, state }).success).toBe(true);
    }
    expect(CampaignTargetDtoSchema.safeParse({ ...target, state: 'DONE' }).success).toBe(false);
  });

  it('parses a detail response', () => {
    const detail = {
      budgetUsd: null,
      cancelledAt: null,
      cancelledById: null,
      completedAt: null,
      counts: countTargets(['SATISFIED', 'PENDING']),
      createdAt: '2026-11-25T12:00:00.000Z',
      createdById: UUID,
      description: 'd',
      expiresAt: null,
      gate: 'OPENED',
      hiddenProposalCount: 0,
      hiddenTargetCount: 0,
      id: UUID,
      launchedById: UUID,
      launcherChangedAt: null,
      maxOpenPullRequests: null,
      maxParallel: 5,
      name: 'n',
      ownerTeamId: UUID,
      pausedReason: null,
      plan: 'UNIFORM',
      proposals: [],
      recipeRef: null,
      rescanIntervalHours: null,
      scopeId: null,
      scopeKind: null,
      staleAfterDays: null,
      state: 'MONITORING',
      targets: [target],
      templateId: UUID,
      templateVersion: 1,
      updatedAt: '2026-11-25T12:00:00.000Z',
      workflowKind: 'RECONCILER',
    };
    expect(CampaignDetailDtoSchema.safeParse(detail).success).toBe(true);
  });
});

describe('request and refusal shapes', () => {
  it('rejects empty and duplicate target additions', () => {
    expect(CampaignAddTargetsBodySchema.safeParse({ repoIds: [] }).success).toBe(false);
    expect(CampaignAddTargetsBodySchema.safeParse({ repoIds: [UUID, UUID] }).success).toBe(false);
    expect(CampaignAddTargetsBodySchema.safeParse({ repoIds: [UUID] }).success).toBe(true);
  });

  it('recognises every refusal code', () => {
    for (const code of CAMPAIGN_REFUSAL_CODES) {
      expect(isCampaignRefusalCode(code)).toBe(true);
      expect(CampaignRefusalSchema.safeParse({ code, message: 'm' }).success).toBe(true);
    }
    expect(isCampaignRefusalCode('NOPE')).toBe(false);
  });
});
