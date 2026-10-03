import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Node, parseWorkflowSpec, type WorkflowSpec } from '../spec.js';
import { BUILTIN_TEMPLATES } from './index.js';

/**
 * Golden check for the built-in templates.
 *
 * `__golden__/<name>.json` is each template's FLAT spec as it was seeded before
 * the templates were rewritten on top of the authoring helpers
 * (`authoring/`). The helpers expand at module load into plain nodes, so what
 * the engine, a run snapshot, template analytics and a bundle hash see must not
 * move: the built spec has to equal its golden, node for node and id for id.
 *
 * The ONLY permitted differences are the entries in {@link INTENDED_CHANGES}
 * below, each with its reason, plus the presentation fields (`group`, and
 * `title` where a node has no inbox title) the helpers add and this test
 * strips before comparing.
 */

const GOLDEN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__golden__');

function golden(name: string): WorkflowSpec {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.json`), 'utf8')) as WorkflowSpec;
}

/** Drop `group`, and `title` on every node type that did not already have one. */
function stripPresentation(spec: WorkflowSpec): WorkflowSpec {
  const nodes: Record<string, Node> = {};
  for (const [id, node] of Object.entries(spec.nodes)) {
    const { group: _group, ...rest } = node as Node & { group?: string };
    if (node.type.startsWith('human')) {
      nodes[id] = rest as Node;
    } else {
      const { title: _title, ...noTitle } = rest as Node & { title?: string };
      nodes[id] = noTitle as Node;
    }
  }
  return { ...spec, nodes };
}

/** Remove a pass-through node, pointing everything that targeted it at its `next`. */
function removePassThrough(spec: WorkflowSpec, id: string): WorkflowSpec {
  const removed = spec.nodes[id] as Node & { next?: string };
  const to = removed.next as string;
  const retarget = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(retarget);
    }
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, retarget(x)]));
    }
    return v === id ? to : v;
  };
  const nodes: Record<string, unknown> = {};
  for (const [nodeId, node] of Object.entries(spec.nodes)) {
    if (nodeId !== id) {
      nodes[nodeId] = retarget(node);
    }
  }
  return {
    ...spec,
    entry: spec.entry === id ? to : spec.entry,
    nodes: nodes as WorkflowSpec['nodes'],
  };
}

/**
 * The nodes of the CI wait-and-fix loop `consensus-review` and `four-eyes` gained, written out
 * by hand (not derived from `ciLoop`). `checkCI` already existed and only changes its edges.
 * The CI fix is pushed by the fix session itself, so `repushAfterFix` only re-arms the PR row.
 */
function ciFixNodes(): Record<string, unknown> {
  return {
    checkCILimit: {
      expr: 'context.ciRetries >= 3',
      onFalse: 'fetchLogs',
      onTrue: 'terminateCIFailed',
      type: 'cond',
    },
    ciFix: {
      inputs: {
        failureContext: { from: 'context.lastCILogs' },
        previousCodeResult: { from: 'context.currentCodeResult' },
      },
      next: 'updateCodeAfterCIFix',
      step: 'executeCIFixImplementation',
      type: 'step',
    },
    fetchLogs: {
      inputs: { logsUrl: { from: 'context.ciResultPayload.logsUrl' } },
      next: 'storeLogs',
      step: 'fetchCILogs',
      type: 'step',
    },
    incCIRetries: {
      next: 'checkCILimit',
      type: 'set',
      values: { 'context.ciRetries': { expr: 'context.ciRetries + 1' } },
    },
    repushAfterFix: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'waitForCI',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    storeLogs: {
      next: 'ciFix',
      type: 'set',
      values: { 'context.lastCILogs': { from: 'nodes.fetchLogs.output' } },
    },
    updateCodeAfterCIFix: {
      next: 'repushAfterFix',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.ciFix.output' } },
    },
  };
}

const PR_RESULT = {
  prNumber: { from: 'context.prNumber' },
  prUrl: { from: 'context.prUrl' },
};

const AWAITING_CI_STAMP = (next: string) => ({
  config: { status: 'AWAITING_CI' },
  next,
  step: 'updateDomainState',
  type: 'step',
});

/** consensus-review: PR and CI first, then the two-reviewer consensus on the green code. */
function consensusReviewAfterCiFirst(g: WorkflowSpec): WorkflowSpec {
  const nodes: Record<string, unknown> = { ...g.nodes };
  const at = (id: string) => nodes[id] as Record<string, unknown>;
  const init = at('initCounters') as { values: Record<string, unknown> };
  nodes.initCounters = {
    ...init,
    next: 'setAwaitingCi',
    values: { 'context.ciRetries': { literal: 0 }, ...init.values },
  };
  nodes.checkCI = { ...at('checkCI'), onFalse: 'incCIRetries', onTrue: 'setReviewing' };
  nodes.checkConsensus = { ...at('checkConsensus'), onTrue: 'done' };
  nodes.setReviewing = {
    config: { status: 'IN_REVIEW' },
    next: 'fanOutReview',
    step: 'updateDomainState',
    type: 'step',
  };
  nodes.updateCodeAfterFix = {
    next: 'setAwaitingCiAfterFix',
    type: 'set',
    values: {
      'context.ciRetries': { literal: 0 },
      'context.currentCodeResult': { from: 'nodes.consensusFix.output' },
    },
  };
  nodes.setAwaitingCiAfterFix = AWAITING_CI_STAMP('repushAfterFix');
  nodes.terminateReviewFailed = { ...at('terminateReviewFailed'), result: PR_RESULT };
  Object.assign(nodes, ciFixNodes());
  return {
    ...g,
    description:
      'Implement, open the PR and wait for CI (a failing CI is fixed by the agent: 2 fix ' +
      'attempts, and a third failure fails the run), then run two independent agent ' +
      'review-network calls in parallel (fanOut with concurrency=2) on the code that passed CI. ' +
      'Both reviewers must approve; if either rejects the agent addresses the combined feedback, ' +
      'CI runs again, and both reviewers run again (up to 3 rounds). ' +
      'Demonstrates fanOut for parallel quality gates rather than parallel work.',
    nodes: nodes as WorkflowSpec['nodes'],
  };
}

/** four-eyes: agent review, PR, CI loop, then both sign-offs on the green code. */
function fourEyesAfterCiFirst(g: WorkflowSpec): WorkflowSpec {
  const nodes: Record<string, unknown> = { ...g.nodes };
  const at = (id: string) => nodes[id] as Record<string, unknown>;
  const init = at('initCounters') as { values: Record<string, unknown> };
  nodes.initCounters = {
    ...init,
    values: {
      'context.ciRetries': { literal: 0 },
      ...init.values,
      'context.signoffRetries': { literal: 0 },
    },
  };
  nodes.checkApproval = { ...at('checkApproval'), onTrue: 'setAwaitingCi' };
  nodes.checkCI = { ...at('checkCI'), onFalse: 'incCIRetries', onTrue: 'setAwaitingSignoff' };
  Object.assign(nodes, ciFixNodes());
  Object.assign(nodes, {
    checkSignoffLimit: {
      expr: 'context.signoffRetries >= 3',
      onFalse: 'signoffFix',
      onTrue: 'terminateRejected',
      type: 'cond',
    },
    firstSignoff: {
      ...at('firstSignoff'),
      contextFrom: 'context.signoffContext',
      description:
        'CI has passed on the head commit in the context, and the pull request is open. ' +
        'Confirm you have read the implementation and are satisfied it meets the requirements. ' +
        'If rejectedBefore is above 0, the code changed after an earlier rejection: earlier ' +
        'sign-offs do not apply and both people sign off again.',
      onReject: 'incSignoffRetries',
    },
    incSignoffRetries: {
      next: 'checkSignoffLimit',
      type: 'set',
      values: { 'context.signoffRetries': { expr: 'context.signoffRetries + 1' } },
    },
    secondSignoff: {
      ...at('secondSignoff'),
      contextFrom: 'context.signoffContext',
      description:
        'You are a second, independent reviewer. CI has passed on the head commit in the ' +
        'context. Confirm the change is safe to merge. If rejectedBefore is above 0, the code ' +
        'changed after an earlier rejection and the first reviewer has signed off on it again.',
      onApprove: 'done',
      onReject: 'incSignoffRetries',
    },
    setAwaitingCiAfterSignoff: AWAITING_CI_STAMP('repushAfterFix'),
    setAwaitingSignoff: {
      config: { status: 'IN_REVIEW' },
      next: 'storeSignoffContext',
      step: 'updateDomainState',
      type: 'step',
    },
    signoffFix: {
      inputs: {
        previousCodeResult: { from: 'context.currentCodeResult' },
        rejectionSummary: {
          literal:
            'A human reviewer rejected this change at sign-off and left no written reason. ' +
            'Re-check it against the success criteria and the pull request description.',
        },
      },
      next: 'updateCodeAfterSignoffFix',
      step: 'executeReviewFixImplementation',
      type: 'step',
    },
    storeSignoffContext: {
      next: 'firstSignoff',
      type: 'set',
      values: {
        'context.signoffContext.changedSinceLastSignoff': { expr: 'context.signoffRetries > 0' },
        'context.signoffContext.ciPassed': { literal: true },
        'context.signoffContext.headSha': { from: 'context.currentCodeResult.headSha' },
        'context.signoffContext.prUrl': { from: 'context.prUrl' },
        'context.signoffContext.rejectedBefore': { from: 'context.signoffRetries' },
      },
    },
    terminateRejected: { ...at('terminateRejected'), result: PR_RESULT },
    terminateTimedOut: { ...at('terminateTimedOut'), result: PR_RESULT },
    updateCodeAfterSignoffFix: {
      next: 'setAwaitingCiAfterSignoff',
      type: 'set',
      values: {
        'context.ciRetries': { literal: 0 },
        'context.currentCodeResult': { from: 'nodes.signoffFix.output' },
      },
    },
  });
  return {
    ...g,
    description:
      'Implement, run the agent review loop, open the PR and wait for CI (a failing CI is ' +
      'fixed by the agent: 2 fix attempts, and a third failure fails the run), then require two ' +
      'sequential human approvals (e.g. author sign-off followed by independent reviewer sign-off) ' +
      'on the code that passed CI. A rejection sends the change back for a fix and through CI ' +
      'again (2 fix attempts, a third rejection fails the run), and both people sign off again. ' +
      'Models a four-eyes / two-person-rule change-management requirement.',
    nodes: nodes as WorkflowSpec['nodes'],
  };
}

/**
 * Deliberate departures from the golden, keyed by template name. Anything not
 * listed here must match exactly.
 */
const INTENDED_CHANGES: Record<
  string,
  { reason: string; apply: (g: WorkflowSpec) => WorkflowSpec }
> = {
  // Seven templates stamped COMPLETED just before their SUCCESS terminate. The finalizer
  // (`finalizeWorkflowRun`) already writes COMPLETED on a SUCCESS run, so the node was a
  // second write of the same fact. Removing it retargets what pointed at it to `done`.
  ...Object.fromEntries(
    [
      'agent-reviewed-pr',
      'code-and-ci',
      'default-engineering',
      'dependency-update',
      'pr-approval-gate',
    ].map((name) => [
      name,
      {
        apply: (g: WorkflowSpec) => removePassThrough(g, 'setCompleted'),
        reason: 'the finalizer already writes COMPLETED on SUCCESS',
      },
    ])
  ),
  // The two templates that ended the run on the first CI failure now fix and retry like their
  // siblings, with CI ahead of the human / consensus gates (and the setCompleted removal above).
  'consensus-review': {
    apply: (g: WorkflowSpec) => consensusReviewAfterCiFirst(removePassThrough(g, 'setCompleted')),
    reason:
      'the finalizer already writes COMPLETED on SUCCESS; the PR opens straight after the ' +
      'implementation, a failing CI is fixed (2 attempts) before anything else, and the ' +
      'two-reviewer consensus runs on the green code, a rejection going fix -> CI -> consensus',
  },
  'four-eyes': {
    apply: (g: WorkflowSpec) => fourEyesAfterCiFirst(removePassThrough(g, 'setCompleted')),
    reason:
      'the finalizer already writes COMPLETED on SUCCESS; CI (with a 2-attempt fix loop) runs ' +
      'after the agent review and before the two sign-offs, which see the green code, and a ' +
      'rejection goes fix -> CI -> both sign-offs again instead of failing the run',
  },
};

describe('built-in templates match their pre-helper golden specs', () => {
  it('has a golden file for every built-in template, and no stray ones', () => {
    const files = readdirSync(GOLDEN_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    expect(files).toEqual(BUILTIN_TEMPLATES.map((t) => t.name).sort());
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.name, t.spec] as const))(
    '%s expands to its golden flat spec',
    (name, spec) => {
      const change = INTENDED_CHANGES[name];
      const expected = change ? change.apply(golden(name)) : golden(name);
      // Strict: a key left as `undefined` would pass toEqual but is not the golden's bytes.
      expect(stripPresentation(spec)).toStrictEqual(expected);
    }
  );

  it.each(BUILTIN_TEMPLATES.map((t) => t.name))(
    'the golden for %s is a spec as stored before group/title existed, and still parses',
    (name) => {
      const raw = golden(name);
      const parsed = parseWorkflowSpec(raw);
      expect(Object.keys(parsed.nodes)).toEqual(Object.keys(raw.nodes));
      for (const node of Object.values(raw.nodes)) {
        expect('group' in node).toBe(false);
      }
    }
  );

  it('keeps removePassThrough honest: it retargets every edge and the entry', () => {
    const spec = parseWorkflowSpec({
      entry: 'a',
      name: 'x',
      nodes: {
        a: { next: 'mid', step: 'runLint', type: 'step' },
        c: { expr: 'x == 1', onFalse: 'mid', onTrue: 'end', type: 'cond' },
        end: { status: 'SUCCESS', type: 'terminate' },
        mid: { next: 'end', step: 'updateDomainState', type: 'step' },
      },
      schemaVersion: 1,
    });
    const out = removePassThrough(spec, 'mid');
    expect(Object.keys(out.nodes)).toEqual(['a', 'c', 'end']);
    expect((out.nodes.a as { next: string }).next).toBe('end');
    expect((out.nodes.c as { onFalse: string }).onFalse).toBe('end');
  });
});
