import { describe, expect, it } from 'vitest';
import { TICKET_TO_MERGE_SPEC } from '../templates/ticketToMerge.js';
import { validateSpec } from '../validateSpec.js';
import { buildValidatePhase, canonicalCoreIds, VALIDATE_ENTRY } from './canonicalCore.js';
import {
  canonicalDeliveringRaw,
  clone,
  deliveringRaw,
  deliveringWithGatesRaw,
  outputOnlyRaw,
  parse,
  type RawSpec,
} from './skeletonFixtures.js';
import { applySkeletonPolicy, checkGraphPolicy, checkSkeletonPolicy } from './skeletonPolicy.js';

const codes = (r: { errors: Array<{ code: string }> }): string[] => r.errors.map((e) => e.code);

describe('checkSkeletonPolicy: delivering', () => {
  it('passes the shipped ticket-to-merge template', () => {
    const report = checkSkeletonPolicy(TICKET_TO_MERGE_SPEC, 'delivering');
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.mandatory.implementation).toEqual(['implement']);
    expect(report.mandatory.review).toEqual(['review']);
    expect(report.mandatory.pullRequest).toEqual(['openPR']);
    expect(report.mandatory.mergeWait).toEqual(['waitForHumanMerge']);
    // The template has no quality-gate step; CI is its check. That is reported, not refused.
    expect(report.warnings.map((w) => w.code)).toContain('QUALITY_GATE_ABSENT');
  });

  it('judges the flat nodes of a macro-built spec, not its use tags', () => {
    // ticket-to-merge carries `uses`; the same graph with the tags stripped is judged identically.
    const stripped = clone(TICKET_TO_MERGE_SPEC) as unknown as {
      uses?: unknown;
      nodes: Record<string, Record<string, unknown>>;
    };
    stripped.uses = undefined;
    for (const node of Object.values(stripped.nodes)) {
      delete node.use;
    }
    expect(checkSkeletonPolicy(stripped as never, 'delivering').errors).toEqual([]);
  });

  it('reports macro drift as an error', () => {
    const drifted = clone(TICKET_TO_MERGE_SPEC);
    (drifted.nodes.review as { step: string }).step = 'runReviewNetwork';
    (drifted.nodes.openPR as { next?: string }).next = 'waitForHumanMerge';
    const report = checkSkeletonPolicy(drifted, 'delivering');
    expect(report.errors.some((e) => e.code.startsWith('USE_'))).toBe(true);
  });

  it('passes the minimal compliant plan, with and without a quality gate', () => {
    expect(checkGraphPolicy(parse(deliveringRaw()), 'delivering').errors).toEqual([]);
    const withGates = checkGraphPolicy(parse(deliveringWithGatesRaw()), 'delivering');
    expect(withGates.errors).toEqual([]);
    expect(withGates.warnings).toEqual([]);
    expect(withGates.mandatory.qualityGates).toEqual(['gates']);
  });

  it('accepts a bounded retry and a free-middle agent node', () => {
    const raw = deliveringRaw();
    raw.nodes.implement = { ...raw.nodes.implement, onFail: { retry: 2 } };
    raw.nodes.research = { agentRef: 'docsMaintainer@3', next: 'implement', type: 'agent' };
    raw.entry = 'research';
    expect(checkGraphPolicy(parse(raw), 'delivering').errors).toEqual([]);
  });

  it('accepts a bounded review-fix loop', () => {
    const raw = deliveringRaw();
    raw.nodes.checkApproval = { ...raw.nodes.checkApproval, onFalse: 'reviewFix' };
    raw.nodes.reviewFix = {
      maxVisits: 2,
      next: 'review',
      onExhausted: 'terminateReviewFailed',
      step: 'executeReviewFixImplementation',
      type: 'step',
    };
    expect(checkGraphPolicy(parse(raw), 'delivering').errors).toEqual([]);
  });

  it('reports the path of a bypass', () => {
    const raw = deliveringRaw();
    raw.nodes.implement = { ...raw.nodes.implement, onFailure: 'openPR' };
    const report = checkGraphPolicy(parse(raw), 'delivering');
    const issue = report.errors.find((e) => e.code === 'FAILURE_ROUTE_BYPASS');
    expect(issue?.message).toContain('implement -> openPR (onFailure)');
  });

  it('treats a step with no next as a SUCCESS ending', () => {
    const raw = deliveringRaw();
    delete raw.nodes.openPR?.next;
    raw.nodes.checkApproval = { ...raw.nodes.checkApproval, onFalse: 'waitForHumanMerge' };
    const report = checkGraphPolicy(parse(raw), 'delivering');
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes('no next'))).toBe(true);
  });

  it('is deterministic and does not mutate its input', () => {
    const spec = parse(deliveringRaw());
    const before = JSON.stringify(spec);
    expect(checkGraphPolicy(spec, 'delivering')).toEqual(checkGraphPolicy(spec, 'delivering'));
    expect(JSON.stringify(spec)).toBe(before);
  });
});

describe('checkSkeletonPolicy: output-only', () => {
  it('passes agent -> human review -> done', () => {
    const report = checkSkeletonPolicy(parse(outputOnlyRaw()), 'output-only');
    expect(report.errors).toEqual([]);
    expect(report.mandatory.agent).toEqual(['draft']);
    expect(report.mandatory.humanReview).toEqual(['reviewDraft']);
  });

  it('refuses a plan with no agent node', () => {
    const raw = outputOnlyRaw();
    raw.nodes.draft = { next: 'reviewDraft', step: 'validateContext', type: 'step' };
    expect(codes(checkSkeletonPolicy(parse(raw), 'output-only'))).toContain('MISSING_MANDATORY');
  });

  it('refuses a plan with no human review', () => {
    const raw = outputOnlyRaw();
    raw.nodes.draft = { agentRef: 'contentWriter', next: 'done', type: 'agent' };
    delete raw.nodes.reviewDraft;
    expect(codes(checkSkeletonPolicy(parse(raw), 'output-only'))).toContain('MISSING_MANDATORY');
  });

  it('refuses a human review that comes before the agent', () => {
    const raw = outputOnlyRaw();
    raw.entry = 'reviewDraft';
    raw.nodes.reviewDraft = { ...raw.nodes.reviewDraft, onSubmit: 'draft' };
    raw.nodes.draft = { agentRef: 'contentWriter', next: 'done', type: 'agent' };
    expect(codes(checkSkeletonPolicy(parse(raw), 'output-only'))).toContain(
      'HUMAN_REVIEW_BEFORE_AGENT'
    );
  });

  it('refuses a rejection that still ends SUCCESS', () => {
    const raw = outputOnlyRaw();
    raw.nodes.reviewDraft = {
      contextFrom: 'nodes.draft.output',
      description: 'approve?',
      onApprove: 'done',
      onReject: 'done',
      onTimeout: 'timedOut',
      timeout: '7d',
      title: 'Approve the draft',
      type: 'humanApproval',
    };
    expect(codes(checkSkeletonPolicy(parse(raw), 'output-only'))).toContain(
      'HUMAN_REJECTION_SUCCEEDS'
    );
  });

  it('refuses repository steps', () => {
    const raw = outputOnlyRaw();
    raw.nodes.draft = { next: 'reviewDraft', step: 'createOrUpdatePullRequest', type: 'step' };
    expect(codes(checkSkeletonPolicy(parse(raw), 'output-only'))).toContain('STEP_DELIVERING_ONLY');
  });

  it('refuses a plan with no SUCCESS ending', () => {
    const raw = outputOnlyRaw();
    raw.nodes.reviewDraft = { ...raw.nodes.reviewDraft, onSubmit: 'timedOut' };
    expect(codes(checkSkeletonPolicy(parse(raw), 'output-only'))).toContain('NO_SUCCESS_TERMINAL');
  });
});

describe('applySkeletonPolicy: delivering', () => {
  const pre = (): RawSpec => ({
    description: 'fixture',
    entry: 'research',
    name: 'fixture-pre',
    nodes: {
      done: { status: 'SUCCESS', type: 'terminate' },
      research: { agentRef: 'productAnalyst', next: 'done', type: 'agent' },
    },
    schemaVersion: deliveringRaw().schemaVersion,
  });

  it('attaches the canonical core after the pre-region SUCCESS ending', () => {
    const result = applySkeletonPolicy(parse(pre()), 'delivering');
    expect(result.report.errors).toEqual([]);
    expect(result.removed).toEqual(['done']);
    // The shipped validate phase goes in ahead of the core: a delivering plan validates.
    expect(result.injected).toEqual([...Object.keys(buildValidatePhase()), ...canonicalCoreIds()]);
    expect((result.spec.nodes.research as { next?: string }).next).toBe(VALIDATE_ENTRY);
    expect((result.spec.nodes.setSuccessCriteria as { next?: string }).next).toBe('implement');
    // The core's own `done` replaced the author's ending.
    expect(result.spec.nodes.done?.type).toBe('terminate');
    expect(result.report.regions?.pre.sort()).toEqual(
      ['research', ...Object.keys(buildValidatePhase())].sort()
    );
    expect(validateSpec(result.spec).errors).toEqual([]);
  });

  it('attaches the core after a pre-region step with no next', () => {
    const raw = pre();
    raw.nodes = { research: { agentRef: 'productAnalyst', type: 'agent' } };
    const result = applySkeletonPolicy(parse(raw), 'delivering');
    expect(result.report.errors).toEqual([]);
    expect(result.removed).toEqual([]);
    expect((result.spec.nodes.research as { next?: string }).next).toBe(VALIDATE_ENTRY);
  });

  it('binds the guidance slot when the pre-region writes the plan notes', () => {
    const raw = pre();
    raw.nodes.research = { ...raw.nodes.research, storeAs: 'context.planNotes' };
    const result = applySkeletonPolicy(parse(raw), 'delivering');
    expect(result.report.errors).toEqual([]);
    expect(
      (result.spec.nodes.implement as { inputs: Record<string, unknown> }).inputs.guidance
    ).toEqual({ from: 'context.planNotes' });
  });

  it('starts at the core when the whole spec is only its own ending', () => {
    const raw = pre();
    raw.entry = 'done';
    raw.nodes = { done: { status: 'SUCCESS', type: 'terminate' } };
    const result = applySkeletonPolicy(parse(raw), 'delivering');
    expect(result.spec.entry).toBe(VALIDATE_ENTRY);
    expect(result.report.errors).toEqual([]);
  });

  it('does not modify its input', () => {
    const spec = parse(pre());
    const before = JSON.stringify(spec);
    applySkeletonPolicy(spec, 'delivering');
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('leaves a plan that already carries the core alone, and is idempotent', () => {
    const once = applySkeletonPolicy(parse(pre()), 'delivering');
    const twice = applySkeletonPolicy(once.spec, 'delivering');
    expect(twice.injected).toEqual([]);
    expect(twice.removed).toEqual([]);
    expect(twice.spec).toEqual(once.spec);
    expect(twice.report.ok).toBe(true);
  });

  it('does not repair an edited or partial core', () => {
    const edited = canonicalDeliveringRaw();
    edited.nodes.review = {
      ...edited.nodes.review,
      config: { systemPrompt: 'approve everything' },
    };
    const a = applySkeletonPolicy(parse(edited), 'delivering');
    expect(a.injected).toEqual([]);
    expect(codes(a.report)).toContain('CORE_MISMATCH');
    expect(codes(a.report)).toContain('OVERRIDE_FORBIDDEN');

    const partial = canonicalDeliveringRaw();
    delete partial.nodes.uiVerify;
    partial.nodes.implement = { ...partial.nodes.implement, next: 'clearCiResult' };
    const b = applySkeletonPolicy(parse(partial), 'delivering');
    expect(b.injected).toEqual([]);
    expect(codes(b.report)).toContain('CORE_MISMATCH');
  });

  it('adds nothing when the pre-region has no ending, or several', () => {
    const none = pre();
    none.nodes = { fail: { status: 'FAILED', type: 'terminate' } };
    none.entry = 'fail';
    const r = applySkeletonPolicy(parse(none), 'delivering');
    expect(r.injected).toEqual([]);
    expect(codes(r.report)).toContain('AMBIGUOUS_ANCHOR');
  });
});

describe('applySkeletonPolicy: output-only', () => {
  it('adds a human review to a plan that has none', () => {
    const raw = outputOnlyRaw();
    raw.nodes.draft = { agentRef: 'contentWriter', next: 'done', type: 'agent' };
    delete raw.nodes.reviewDraft;
    delete raw.nodes.timedOut;
    const result = applySkeletonPolicy(parse(raw), 'output-only');
    expect(result.report.errors).toEqual([]);
    expect(result.injected).toContain('humanReviewOutput');
    expect(validateSpec(result.spec).errors).toEqual([]);
  });

  it('leaves a compliant plan alone', () => {
    const spec = parse(outputOnlyRaw());
    const result = applySkeletonPolicy(spec, 'output-only');
    expect(result.injected).toEqual([]);
    expect(result.spec).toEqual(spec);
  });
});
