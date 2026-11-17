import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  buildCreateBody,
  costNote,
  deliveryEffect,
  describeJobFailure,
  describePlanError,
  expiryLabel,
  FEEDS_IMPLEMENTER_LABEL,
  formatUsd,
  GENERIC_PLAN_ERROR_CODES,
  intentError,
  nodeAction,
  nodeReads,
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

describe('error code coverage', () => {
  const GATEWAY = join(__dirname, '../../../gateway/src');
  const files = [
    'routes/runPlans.ts',
    'lib/runPlanService.ts',
    'lib/runPlanStart.ts',
    'lib/runPlanQuotas.ts',
  ];
  const emitted = (): string[] => {
    const codes = new Set<string>();
    for (const file of files) {
      const text = readFileSync(join(GATEWAY, file), 'utf8');
      for (const m of text.matchAll(
        /'((?:PLAN|RUN_PLAN|RUN|AGENT|REPO|IDEMPOTENCY|PLANNED)[A-Z0-9]*_[A-Z0-9_]+)'/g
      )) {
        codes.add(m[1] as string);
      }
      for (const m of text.matchAll(
        /(?:refuse\(\s*\d{3},\s*|sendError\(\s*reply,\s*\d{3},\s*)'([A-Z][A-Z0-9_]+)'/g
      )) {
        codes.add(m[1] as string);
      }
    }
    return [...codes].sort();
  };

  it('finds the codes the gateway emits', () => {
    expect(emitted()).toEqual(expect.arrayContaining(['PLAN_LAUNCH_FAILED', 'PLAN_EXPIRED']));
  });

  it('maps every emitted code, or lists it as intentionally generic', () => {
    const unmapped = emitted().filter((code) => {
      const view = describePlanError(new ApiError('SENTINEL', 400, code));
      return view.message === 'SENTINEL' && !GENERIC_PLAN_ERROR_CODES.includes(code);
    });
    expect(unmapped).toEqual([]);
  });

  it('words each of the previously missing codes', () => {
    for (const code of [
      'IDEMPOTENCY_KEY_MISMATCH',
      'PLAN_NOT_LAUNCHABLE',
      'RUN_CONFLICT',
      'REPO_HOST_NOT_ALLOWED',
      'AGENT_RUNS_DISABLED',
      'PLAN_POLICY_FAILED',
      'PLAN_SPEC_INVALID',
      'PLAN_CATALOG_STALE',
      'PLAN_AGENT_NOT_LAUNCHABLE',
      'PLAN_LAUNCH_FAILED',
      'PLAN_LAUNCH_IN_PROGRESS',
    ]) {
      const view = describePlanError(new ApiError('raw gateway text', 409, code));
      expect(view.message, code).not.toBe('raw gateway text');
      expect(view.title, code).not.toBe('The request failed');
    }
    expect(describePlanError(new ApiError('x', 409, 'PLAN_CATALOG_STALE')).drift).toBe('catalog');
  });
});

describe('node action and feeding label', () => {
  it('describes an agent node by its agent and where its input comes from', () => {
    const node = { id: 'a', marker: 'free', region: 'pre', step: null, type: 'agent' } as const;
    expect(
      nodeAction({
        ...node,
        agentRef: 'planner',
        inputs: [{ from: 'request.description', key: 'g' }],
      })
    ).toBe('runs agent planner on the goal');
    expect(
      nodeAction({ ...node, agentRef: 'writer@2', inputs: [{ from: 'nodes.a.output', key: 'p' }] })
    ).toBe('runs agent writer@2 on the output of "a"');
    expect(nodeAction({ ...node, type: 'step' })).toBeNull();
    expect(FEEDS_IMPLEMENTER_LABEL).toBe('Output becomes guidance for the implementer');
  });

  it('describes what a step reads and flags a fallback without showing it', () => {
    const step = {
      id: 's',
      marker: 'free',
      region: 'pre',
      step: 'retrieveKnowledge',
      type: 'step',
    } as const;
    expect(nodeReads({ ...step })).toBeNull();
    expect(
      nodeReads({
        ...step,
        inputs: [
          { from: 'context.ticket', hasDefault: true, key: 'query' },
          { from: null, key: 'limit' },
        ],
      })
    ).toBe('reads query from `context.ticket` (has fallback value), limit from a fixed value');
    expect(nodeReads({ ...step, inputs: [], type: 'agent' })).toBeNull();
  });

  it('carries the action and the feeding flag into the outline', () => {
    const groups = outlineGroups({
      nodes: [
        {
          agentRef: 'planner',
          feedsImplementer: true,
          id: 'p',
          inputs: [{ from: 'request.description', key: 'g' }],
          marker: 'free',
          region: 'pre',
          step: null,
          type: 'agent',
          writes: ['context.planNotes'],
        },
      ],
      spec: {},
    });
    expect(groups[0]?.nodes[0]).toMatchObject({
      action: 'runs agent planner on the goal',
      feedsImplementer: true,
    });
  });
});
