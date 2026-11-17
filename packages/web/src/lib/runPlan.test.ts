import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  buildCreateBody,
  costNote,
  deliveryEffect,
  describeJobFailure,
  describePlanError,
  expiryLabel,
  formatUsd,
  intentError,
  outlineGroups,
  parseCost,
  pollDelayMs,
  RUN_PLAN_INTENT_MAX_CHARS,
  workflowLaunchHref,
} from './runPlan';

describe('intentError', () => {
  it('refuses empty and over-length goals, never truncating', () => {
    expect(intentError('  ')).toMatch(/describe/i);
    expect(intentError('x'.repeat(RUN_PLAN_INTENT_MAX_CHARS))).toBeNull();
    expect(intentError('x'.repeat(RUN_PLAN_INTENT_MAX_CHARS + 5))).toMatch(/at most 8,000.*by 5/);
  });
  it('builds a body with an agent only when one is chosen', () => {
    expect(buildCreateBody({ agent: '', intent: ' a ', repoId: 'r' })).toEqual({
      intent: 'a',
      repoId: 'r',
    });
    expect(buildCreateBody({ agent: 'writer', intent: 'a', repoId: 'r' }).agent).toBe('writer');
  });
});

describe('describePlanError', () => {
  const err = (status: number, code: string | null, details?: unknown) =>
    new ApiError('server text', status, code, details);
  it('maps generation failure codes to fixed wording', () => {
    expect(describePlanError(err(200, 'PLAN_GENERATION_FAILED'))).toMatchObject({
      retryable: true,
      title: 'No plan could be generated',
    });
    expect(describePlanError(err(400, 'PLAN_INPUT_INVALID')).retryable).toBe(false);
    expect(describePlanError(err(400, 'PLAN_AGENTS_UNAVAILABLE')).title).toMatch(/agent/i);
    expect(describePlanError(err(400, 'PLAN_KEY_REUSED')).retryable).toBe(true);
  });
  it('maps quota, admission and disabled responses', () => {
    expect(describePlanError(err(429, 'RUN_PLAN_RATE_LIMITED')).title).toBe('Too many plans');
    expect(describePlanError(err(429, null)).title).toBe('Limit reached');
    expect(describePlanError(err(429, 'AGENT_RUN_CONCURRENCY_EXCEEDED')).retryable).toBe(true);
    expect(describePlanError(err(403, 'RUN_PLANS_DISABLED')).title).toBe('Plans are turned off');
  });
  it('names the drift kind on a 409', () => {
    const view = describePlanError(err(409, 'PLAN_AGENTS_CHANGED', { drift: 'agents' }));
    expect(view.drift).toBe('agents');
    expect(view.message).toMatch(/agents/);
    expect(describePlanError(err(409, null, { drift: 'catalog' })).drift).toBe('catalog');
  });
  it('maps a job failure through the same table', () => {
    expect(
      describeJobFailure({ code: 'PLAN_GENERATION_FAILED', message: 'x', retryable: true }).title
    ).toBe('No plan could be generated');
  });
});

describe('polling and display helpers', () => {
  it('backs off and caps', () => {
    expect(pollDelayMs(0)).toBe(1000);
    expect(pollDelayMs(3)).toBeGreaterThan(pollDelayMs(1));
    expect(pollDelayMs(50)).toBe(8000);
  });
  it('formats cost and the unpriced note', () => {
    expect(formatUsd(0.004)).toBe('< $0.01');
    expect(formatUsd(1.234)).toBe('$1.23');
    const cost = parseCost({ totalUsd: 1, unpriced: [{ nodeId: 'a', reason: 'no-cost-hint' }] });
    expect(costNote(cost)).toMatch(/1 step is unpriced/);
    expect(parseCost('junk').totalUsd).toBeNull();
  });
  it('labels expiry', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(expiryLabel('2026-01-01T00:30:00Z', now)).toBe('Expires in 30 min');
    expect(expiryLabel('2026-01-01T02:05:00Z', now)).toBe('Expires in 2 h 5 min');
    expect(expiryLabel('2025-12-31T00:00:00Z', now)).toBe('Expired');
  });
  it('states the delivery effect per mode', () => {
    expect(deliveryEffect('delivering')).toMatch(/draft pull request/);
    expect(deliveryEffect('output-only')).toMatch(/No pull request/);
  });
  it('groups nodes by region in run order', () => {
    const groups = outlineGroups({
      nodes: [
        { id: 'c', marker: 'core', region: 'core', step: 's', type: 'step' },
        { id: 'p', marker: 'free', region: 'pre', step: null, type: 'agent' },
      ],
      spec: { nodes: { p: { label: 'Plan it' } } },
    });
    expect(groups.map((g) => g.region)).toEqual(['pre', 'core']);
    expect(groups[0]?.nodes[0]?.title).toBe('Plan it');
  });
  it('encodes the workflow link', () => {
    expect(workflowLaunchHref('t 1', 'r')).toBe('/start?mode=workflow&template=t%201&repo=r');
  });
});
