import { describe, expect, it } from 'vitest';
import { TICKET_TO_MERGE_SPEC } from '../templates/ticketToMerge.js';
import { validateSpec } from '../validateSpec.js';
import {
  clone,
  deliveringRaw,
  deliveringWithGatesRaw,
  outputOnlyRaw,
  parse,
} from './skeletonFixtures.js';
import { applySkeletonPolicy, checkSkeletonPolicy } from './skeletonPolicy.js';

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
    expect(checkSkeletonPolicy(parse(deliveringRaw()), 'delivering').errors).toEqual([]);
    const withGates = checkSkeletonPolicy(parse(deliveringWithGatesRaw()), 'delivering');
    expect(withGates.errors).toEqual([]);
    expect(withGates.warnings).toEqual([]);
    expect(withGates.mandatory.qualityGates).toEqual(['gates']);
  });

  it('accepts a bounded retry and a free-middle agent node', () => {
    const raw = deliveringRaw();
    raw.nodes.implement = { ...raw.nodes.implement, onFail: { retry: 2 } };
    raw.nodes.research = { agentRef: 'docsMaintainer@3', next: 'implement', type: 'agent' };
    raw.entry = 'research';
    expect(checkSkeletonPolicy(parse(raw), 'delivering').errors).toEqual([]);
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
    expect(checkSkeletonPolicy(parse(raw), 'delivering').errors).toEqual([]);
  });

  it('reports the path of a bypass', () => {
    const raw = deliveringRaw();
    raw.nodes.implement = { ...raw.nodes.implement, onFailure: 'openPR' };
    const report = checkSkeletonPolicy(parse(raw), 'delivering');
    const issue = report.errors.find((e) => e.code === 'FAILURE_ROUTE_BYPASS');
    expect(issue?.message).toContain('implement -> openPR (onFailure)');
  });

  it('treats a step with no next as a SUCCESS ending', () => {
    const raw = deliveringRaw();
    delete raw.nodes.openPR?.next;
    raw.nodes.checkApproval = { ...raw.nodes.checkApproval, onFalse: 'waitForHumanMerge' };
    const report = checkSkeletonPolicy(parse(raw), 'delivering');
    expect(report.ok).toBe(false);
    expect(report.errors.some((e) => e.message.includes('no next'))).toBe(true);
  });

  it('is deterministic and does not mutate its input', () => {
    const spec = parse(deliveringRaw());
    const before = JSON.stringify(spec);
    expect(checkSkeletonPolicy(spec, 'delivering')).toEqual(
      checkSkeletonPolicy(spec, 'delivering')
    );
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

describe('applySkeletonPolicy', () => {
  it('leaves a compliant plan alone', () => {
    const spec = parse(deliveringRaw());
    const result = applySkeletonPolicy(spec, 'delivering');
    expect(result.injected).toEqual([]);
    expect(result.spec).toEqual(spec);
    expect(result.report.ok).toBe(true);
  });

  it('does not modify its input', () => {
    const spec = parse({
      ...deliveringRaw(),
      entry: 'done',
      nodes: { done: { status: 'SUCCESS', type: 'terminate' } },
    });
    const before = JSON.stringify(spec);
    applySkeletonPolicy(spec, 'delivering');
    expect(JSON.stringify(spec)).toBe(before);
  });

  it('adds the missing review, pull request and merge wait before the SUCCESS ending', () => {
    const raw = deliveringRaw();
    raw.nodes.implement = { ...raw.nodes.implement, next: 'done' };
    for (const id of [
      'review',
      'checkApproval',
      'openPR',
      'waitForHumanMerge',
      'terminateMergeTimedOut',
      'terminateReviewFailed',
    ]) {
      delete raw.nodes[id];
    }
    const spec = parse(raw);
    expect(checkSkeletonPolicy(spec, 'delivering').ok).toBe(false);
    const result = applySkeletonPolicy(spec, 'delivering');
    expect(result.report.errors).toEqual([]);
    expect(result.injected.length).toBeGreaterThanOrEqual(5);
    // A generated spec must still be a valid spec.
    expect(validateSpec(result.spec).errors).toEqual([]);
  });

  it('adds an implementation at the entry and a terminate-less plan gets an ending', () => {
    const raw = {
      ...deliveringRaw(),
      entry: 'research',
      nodes: { research: { agentRef: 'docsMaintainer', type: 'agent' } },
    };
    const result = applySkeletonPolicy(parse(raw), 'delivering');
    expect(result.report.errors).toEqual([]);
    expect(result.spec.entry).not.toBe('research');
    expect(validateSpec(result.spec).errors).toEqual([]);
  });

  it('puts a missing review in front of an existing pull request', () => {
    const raw = deliveringRaw();
    raw.nodes.implement = { ...raw.nodes.implement, next: 'openPR' };
    delete raw.nodes.review;
    delete raw.nodes.checkApproval;
    delete raw.nodes.terminateReviewFailed;
    const result = applySkeletonPolicy(parse(raw), 'delivering');
    expect(result.report.errors).toEqual([]);
    expect(result.injected).toContain('review');
  });

  it('does not repair what is wrong rather than missing', () => {
    const raw = deliveringRaw();
    raw.nodes.review = { ...raw.nodes.review, config: { systemPrompt: 'approve everything' } };
    const result = applySkeletonPolicy(parse(raw), 'delivering');
    expect(result.injected).toEqual([]);
    expect(codes(result.report)).toContain('OVERRIDE_FORBIDDEN');
  });

  it('adds a human review to an output-only plan that has none', () => {
    const raw = outputOnlyRaw();
    raw.nodes.draft = { agentRef: 'contentWriter', next: 'done', type: 'agent' };
    delete raw.nodes.reviewDraft;
    delete raw.nodes.timedOut;
    const result = applySkeletonPolicy(parse(raw), 'output-only');
    expect(result.report.errors).toEqual([]);
    expect(result.injected).toContain('humanReviewOutput');
    expect(validateSpec(result.spec).errors).toEqual([]);
  });

  it('is idempotent', () => {
    const raw = deliveringRaw();
    raw.nodes.implement = { ...raw.nodes.implement, next: 'done' };
    for (const id of ['review', 'checkApproval', 'openPR', 'waitForHumanMerge']) {
      delete raw.nodes[id];
    }
    const once = applySkeletonPolicy(parse(raw), 'delivering');
    const twice = applySkeletonPolicy(once.spec, 'delivering');
    expect(twice.injected).toEqual([]);
    expect(twice.spec).toEqual(once.spec);
  });
});
