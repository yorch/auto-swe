import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  autonomyPolicyFindFirst: vi.fn(),
  evalRubricFindFirst: vi.fn().mockResolvedValue(null),
  scannerPatternFindMany: vi.fn(),
  workflowRunFindUnique: vi.fn(),
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    autonomyPolicy: { findFirst: mocks.autonomyPolicyFindFirst },
    evalRubric: { findFirst: mocks.evalRubricFindFirst },
    scannerPattern: { findMany: mocks.scannerPatternFindMany },
    workflowRun: { findUnique: mocks.workflowRunFindUnique },
  },
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkflowDefaults: vi.fn(),
}));
vi.mock('../lib/activityContext.js', () => ({
  currentWorkflowRunId: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/evalCapture.js', () => ({ recordEvalResult: vi.fn() }));

import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { EvalScorer } from '@auto-swe/shared/workflow';
import { currentWorkflowRunId } from '../lib/activityContext.js';
import type { ScoreInput } from '../lib/scorerCombination.js';
import { assembleScores, evalAssert, runEvalNode } from './runEvalNode.js';

const mockResolveDefaults = vi.mocked(resolveWorkflowDefaults);
const mockCurrentWorkflowRunId = vi.mocked(currentWorkflowRunId);

describe('evalAssert', () => {
  it('evaluates numeric comparisons against a json path', () => {
    expect(evalAssert('$.linesChanged < 500', { linesChanged: 120 })).toBe(true);
    expect(evalAssert('$.linesChanged < 500', { linesChanged: 900 })).toBe(false);
    expect(evalAssert('$.score >= 0.8', { score: 0.8 })).toBe(true);
    expect(evalAssert('$.n == 3', { n: 3 })).toBe(true);
    expect(evalAssert('$.n != 3', { n: 3 })).toBe(false);
  });

  it('supports nested paths and bare truthiness', () => {
    expect(evalAssert('$.a.b > 1', { a: { b: 2 } })).toBe(true);
    expect(evalAssert('$.ok', { ok: true })).toBe(true);
    expect(evalAssert('$.ok', { ok: false })).toBe(false);
  });

  it('is false for a missing field or unparseable expr', () => {
    expect(evalAssert('$.missing < 1', {})).toBe(false);
    expect(evalAssert('garbage', {})).toBe(false);
  });
});

describe('assembleScores', () => {
  const gatePass: ScoreInput = { kind: 'gate', passed: true, scorer: 'gate:t', value: 1 };
  const gateFail: ScoreInput = { kind: 'gate', passed: false, scorer: 'gate:t', value: 0 };
  const judge: ScoreInput = { kind: 'judge', scorer: 'judge:q', value: 0.2 };
  const judge05: ScoreInput = { kind: 'judge', scorer: 'judge:q', value: 0.5 };

  it('gates to 0 and blocks on floor failure', () => {
    const r = assembleScores([gateFail, judge], true);
    expect(r.score).toBe(0);
    expect(r.floorPassed).toBe(false);
    expect(r.decision.blocked).toBe(true);
  });

  it('passes the floor and keeps the judge advisory by default', () => {
    const r = assembleScores([gatePass, judge], true);
    expect(r.floorPassed).toBe(true);
    expect(r.decision.blocked).toBe(false);
    expect(r.perAxis['judge:q']).toBe(0.2);
  });

  it('blocks on a weak judge when not advisory', () => {
    const r = assembleScores([gatePass, judge], false);
    expect(r.decision.blocked).toBe(true);
  });

  it('respects a caller-supplied judgeThreshold (config-driven) in the gate decision', () => {
    // Same judge value (0.5), opposite decisions depending on the threshold the
    // caller threads through — proving the param reaches decideGate.
    expect(assembleScores([gatePass, judge05], false, 0.8).decision.blocked).toBe(true);
    expect(assembleScores([gatePass, judge05], false, 0.4).decision.blocked).toBe(false);
  });
});

describe('runEvalNode (judge threshold from DB config)', () => {
  // A judge scorer with no rubric row scores 0.5; whether that blocks depends on
  // the evalJudgeThreshold resolved from workflow_defaults, so a distinctive
  // mocked value must decide the gate.
  const judgeScorer = { kind: 'judge', rubricRef: 'quality' } as EvalScorer;

  it('blocks the gate when the resolved evalJudgeThreshold exceeds the judge score', async () => {
    mockResolveDefaults.mockResolvedValue({ evalJudgeThreshold: 0.8 } as never);
    const r = await runEvalNode({ judgeAdvisory: false, scorers: [judgeScorer], targetValue: {} });
    expect(r.decision.blocked).toBe(true);
    expect(r.decision.reason).toContain('0.8');
  });

  it('passes the gate when the resolved evalJudgeThreshold is below the judge score', async () => {
    mockResolveDefaults.mockResolvedValue({ evalJudgeThreshold: 0.4 } as never);
    const r = await runEvalNode({ judgeAdvisory: false, scorers: [judgeScorer], targetValue: {} });
    expect(r.decision.blocked).toBe(false);
  });
});

describe('runEvalNode (policy scorer)', () => {
  const policyScorer = { kind: 'policy', riskClass: 'internal_read' } as EvalScorer;

  it('passes when the resolved autonomy policy allows the risk class', async () => {
    mockResolveDefaults.mockResolvedValue({} as never);
    mockCurrentWorkflowRunId.mockResolvedValue('run-1');
    mocks.workflowRunFindUnique.mockResolvedValue({
      template: { teamId: null },
      templateId: 'tpl-1',
    });
    mocks.autonomyPolicyFindFirst.mockResolvedValue(null);
    const r = await runEvalNode({ scorers: [policyScorer], targetValue: {} });
    expect(r.floorPassed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.decision.blocked).toBe(false);
  });

  it('fails when the resolved autonomy policy denies the risk class', async () => {
    mockResolveDefaults.mockResolvedValue({} as never);
    mockCurrentWorkflowRunId.mockResolvedValue('run-1');
    mocks.workflowRunFindUnique.mockResolvedValue({
      template: { teamId: null },
      templateId: 'tpl-1',
    });
    mocks.autonomyPolicyFindFirst.mockResolvedValue({
      isDefault: false,
      name: 'comms',
      rules: { mass_communication: { action: 'require_approval', approverCount: 2 } },
      teamId: null,
      templateId: 'tpl-1',
    });
    const r = await runEvalNode({
      scorers: [{ kind: 'policy', riskClass: 'mass_communication' } as EvalScorer],
      targetValue: {},
    });
    expect(r.floorPassed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.decision.blocked).toBe(true);
  });
});

describe('runEvalNode (pii scorer)', () => {
  it('passes when no PII patterns match', async () => {
    mockResolveDefaults.mockResolvedValue({} as never);
    mocks.scannerPatternFindMany.mockResolvedValue([]);
    const r = await runEvalNode({
      scorers: [{ kind: 'pii' } as EvalScorer],
      targetValue: 'hello world',
    });
    expect(r.floorPassed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.decision.blocked).toBe(false);
  });

  it('fails when a PII pattern matches', async () => {
    mockResolveDefaults.mockResolvedValue({} as never);
    mocks.scannerPatternFindMany.mockResolvedValue([
      { flags: '', label: 'test-word', pattern: '\\btest\\b' },
    ]);
    const r = await runEvalNode({
      scorers: [{ kind: 'pii' } as EvalScorer],
      targetValue: 'this is a test',
    });
    expect(r.floorPassed).toBe(false);
    expect(r.score).toBe(0);
    expect(r.decision.blocked).toBe(true);
  });
});
