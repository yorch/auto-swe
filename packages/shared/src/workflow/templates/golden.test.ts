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
      next: 'checkCiFixChanged',
      step: 'executeCIFixImplementation',
      type: 'step',
    },
    // A fix that changed nothing makes no commit, so no CI event would follow: it counts as a
    // spent attempt and the loop goes round again instead of waiting.
    checkCiFixChanged: {
      expr: 'nodes.ciFix.output.headSha == context.currentCodeResult.headSha',
      onFalse: 'updateCodeAfterCIFix',
      onTrue: 'incCIRetries',
      type: 'cond',
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

const GENERIC_REJECTION =
  'A human reviewer rejected this change at sign-off and left no written reason. ' +
  'Re-check it against the success criteria and the pull request description.';

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
  nodes.consensusFix = { ...at('consensusFix'), next: 'checkConsensusFixChanged' };
  nodes.checkConsensusFixChanged = {
    expr: 'nodes.consensusFix.output.headSha == context.currentCodeResult.headSha',
    onFalse: 'updateCodeAfterFix',
    onTrue: 'setReviewing',
    type: 'cond',
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
    askRejectionReason: {
      description:
        'Say what should change. The fix is told this. Leave it empty or let it time out ' +
        'and the fix gets only the fact that the change was rejected.',
      fields: [{ key: 'reason', label: 'What should change?', required: false, type: 'text' }],
      onSubmit: 'checkRejectionReason',
      onTimeout: 'incSignoffRetries',
      storeAs: 'context.signoffRejection',
      timeout: '1h',
      title: 'Why was it rejected?',
      type: 'humanInput',
    },
    checkRejectionReason: {
      expr: "(context.signoffRejection.value.reason ?? '') != ''",
      onFalse: 'incSignoffRetries',
      onTrue: 'keepRejectionReason',
      type: 'cond',
    },
    checkSignoffFixChanged: {
      expr: 'nodes.signoffFix.output.headSha == context.currentCodeResult.headSha',
      onFalse: 'updateCodeAfterSignoffFix',
      onTrue: 'storeSignoffContextUnchanged',
      type: 'cond',
    },
    firstSignoff: {
      ...at('firstSignoff'),
      contextFrom: 'context.signoffContext',
      description:
        'CI has passed on the head commit in the context, and the pull request is open. ' +
        'Confirm you have read the implementation and are satisfied it meets the requirements. ' +
        'If rejectedBefore is above 0 this is a repeat round and both people sign off again: ' +
        'changedSinceLastSignoff says whether the code changed, and noChangeMade means the ' +
        'fix made no change and this is the code that was rejected before.',
      onReject: 'askRejectionReason',
    },
    keepRejectionReason: {
      next: 'incSignoffRetries',
      type: 'set',
      values: {
        'context.signoffRejectionSummary': { from: 'context.signoffRejection.value.reason' },
      },
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
        'context. Confirm the change is safe to merge. If rejectedBefore is above 0 this is a ' +
        'repeat round and the first reviewer has signed off again: changedSinceLastSignoff ' +
        'says whether the code changed, and noChangeMade means the fix made no change.',
      onApprove: 'done',
      onReject: 'askRejectionReason',
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
        rejectionSummary: { from: 'context.signoffRejectionSummary' },
      },
      next: 'checkSignoffFixChanged',
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
        'context.signoffContext.noChangeMade': { literal: false },
        'context.signoffContext.prUrl': { from: 'context.prUrl' },
        'context.signoffContext.rejectedBefore': { from: 'context.signoffRetries' },
        'context.signoffRejection': { literal: null },
        'context.signoffRejectionSummary': { literal: GENERIC_REJECTION },
      },
    },
    storeSignoffContextUnchanged: {
      next: 'firstSignoff',
      type: 'set',
      values: {
        'context.signoffContext.changedSinceLastSignoff': { literal: false },
        'context.signoffContext.noChangeMade': { literal: true },
        'context.signoffContext.rejectedBefore': { from: 'context.signoffRetries' },
        'context.signoffRejection': { literal: null },
        'context.signoffRejectionSummary': { literal: GENERIC_REJECTION },
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
      'on the code that passed CI. A rejection asks for a reason, sends the change back for a fix ' +
      'and through CI again (2 fix attempts, a third rejection fails the run), and both people ' +
      'sign off again. A fix that changes nothing goes straight back to the two people, marked as ' +
      'unchanged. Models a four-eyes / two-person-rule change-management requirement.',
    nodes: nodes as WorkflowSpec['nodes'],
  };
}

/**
 * Deliberate departures from the golden, keyed by template name. Anything not
 * listed here must match exactly.
 */
/**
 * default-engineering stores a lesson when its review or CI loop runs out of attempts or its
 * merge wait times out, and tags each `commitToMemory` step with the outcome it records. The
 * three lesson steps sit on the loops' exhausted edges and the merge wait's timeout edge, and
 * continue to the same terminals on error.
 */
function defaultEngineeringFailureLessons(g: WorkflowSpec): WorkflowSpec {
  const nodes = structuredClone(g.nodes) as Record<string, Record<string, unknown>>;
  const lesson = (outcome: string, next: string) => ({
    inputs: { outcome: { literal: outcome } },
    next,
    onError: 'continue',
    step: 'commitToMemory',
    type: 'step',
  });
  (nodes.checkReviewLimit as Record<string, unknown>).onTrue = 'lessonReviewFailed';
  (nodes.checkCILimit as Record<string, unknown>).onTrue = 'lessonCIFailed';
  nodes.lessonReviewFailed = lesson('REVIEW_FAILED', 'terminateReviewFailed');
  nodes.lessonCIFailed = lesson('CI_FAILED', 'terminateCIFailed');
  (nodes.waitForHumanMerge as Record<string, unknown>).onTimeout = 'lessonMergeTimedOut';
  nodes.lessonMergeTimedOut = lesson('MERGE_TIMED_OUT', 'terminateMergeTimedOut');
  nodes.commitLesson = { inputs: { outcome: { literal: 'MERGED' } }, ...nodes.commitLesson };
  return { ...g, nodes: nodes as WorkflowSpec['nodes'] };
}

/**
 * The other engineering templates store a lesson the same way when a review or CI loop runs
 * out of attempts: a `commitToMemory` step on the loop's exhausted edge (`checkReviewLimit` /
 * `checkCILimit`) that continues to the same terminal, on error too.
 */
function failureLessons(g: WorkflowSpec, loops: ReadonlyArray<'review' | 'ci'>): WorkflowSpec {
  const nodes = structuredClone(g.nodes) as Record<string, Record<string, unknown>>;
  const lesson = (outcome: string, next: string) => ({
    inputs: { outcome: { literal: outcome } },
    next,
    onError: 'continue',
    step: 'commitToMemory',
    type: 'step',
  });
  if (loops.includes('review')) {
    (nodes.checkReviewLimit as Record<string, unknown>).onTrue = 'lessonReviewFailed';
    nodes.lessonReviewFailed = lesson('REVIEW_FAILED', 'terminateReviewFailed');
  }
  if (loops.includes('ci')) {
    (nodes.checkCILimit as Record<string, unknown>).onTrue = 'lessonCIFailed';
    nodes.lessonCIFailed = lesson('CI_FAILED', 'terminateCIFailed');
  }
  return { ...g, nodes: nodes as WorkflowSpec['nodes'] };
}

/**
 * ci-triage-and-fix checks a fix against the failing step's own command after the tests and
 * before delivery, keeps what it found, and reports it with the fix.
 */
function ciTriageVerification(g: WorkflowSpec): WorkflowSpec {
  const nodes = structuredClone(g.nodes) as Record<string, Record<string, unknown>>;
  nodes.runTests = { ...nodes.runTests, next: 'verifyFix' };
  nodes.verifyFix = {
    inputs: {
      codeResult: { from: 'context.currentCodeResult' },
      triage: { from: 'context.ciTriage' },
    },
    next: 'storeVerification',
    onFail: 'warn',
    step: 'verifyCiFix',
    type: 'step',
  };
  nodes.storeVerification = {
    expr: 'nodes.verifyFix.output == null',
    onFalse: 'keepVerification',
    onTrue: 'routeDelivery',
    type: 'cond',
  };
  nodes.keepVerification = {
    next: 'routeDelivery',
    type: 'set',
    values: {
      'context.ciVerification': { from: 'nodes.verifyFix.output.verification' },
      'context.currentCodeResult': { from: 'nodes.verifyFix.output.codeResult' },
    },
  };
  const verification = { from: 'context.ciVerification' };
  for (const id of ['reportPushed', 'reportFix']) {
    const node = nodes[id] as { inputs: Record<string, unknown> };
    node.inputs = { ...node.inputs, verification };
  }
  for (const id of ['pushed', 'done']) {
    const node = nodes[id] as { result: Record<string, unknown> };
    node.result = { ...node.result, verification };
  }
  return { ...g, nodes: nodes as WorkflowSpec['nodes'] };
}

/**
 * ci-triage-and-fix watches the pull request's CI on a pushed fix: one follow-up attempt when
 * it fails (unless the trigger allows no revisions), then a comment, and the run's work branch
 * removed when it ends.
 */
function ciTriagePushWatch(g: WorkflowSpec): WorkflowSpec {
  const nodes = structuredClone(g.nodes) as Record<string, Record<string, unknown>>;
  const verification = { from: 'context.ciVerification' };
  const pushed = { from: 'context.pushedCommitSha' };
  nodes.checkPushed = { ...nodes.checkPushed, onTrue: 'startPushWatch' };
  nodes.pushFix = { ...nodes.pushFix, config: { keepWorkBranch: true } };
  nodes.startPushWatch = {
    next: 'reportPushed',
    type: 'set',
    values: {
      'context.pushedCommitSha': { from: 'nodes.pushFix.output.commitSha' },
      'context.pushRetries': { literal: 0 },
    },
  };
  nodes.reportPushed = {
    ...nodes.reportPushed,
    inputs: { pushedCommitSha: pushed, triage: { from: 'context.ciTriage' }, verification },
    next: 'watchPushedCi',
  };
  nodes.watchPushedCi = {
    inputs: { ref: pushed },
    next: 'checkPushedCi',
    onError: 'continue',
    step: 'waitForCiByPolling',
    type: 'step',
  };
  nodes.checkPushedCi = {
    expr: 'nodes.watchPushedCi.output.ciPassed == false',
    onFalse: 'finishPushed',
    onTrue: 'checkPushRetries',
    type: 'cond',
  };
  nodes.checkPushRetries = {
    expr: 'context.pushRetries >= 1 || (request.payload.maxCiFixAttempts ?? 2) == 0',
    onFalse: 'countPushRetry',
    onTrue: 'reportPushFailed',
    type: 'cond',
  };
  nodes.countPushRetry = {
    next: 'fetchPushedLogs',
    type: 'set',
    values: { 'context.pushRetries': { expr: 'context.pushRetries + 1' } },
  };
  nodes.fetchPushedLogs = {
    inputs: { logsUrl: { from: 'nodes.watchPushedCi.output.logsUrl' } },
    next: 'pushRetryFix',
    onFail: 'warn',
    step: 'fetchCILogs',
    type: 'step',
  };
  nodes.pushRetryFix = {
    config: { refuseWorkflowChanges: true, untrustedCiLogs: true },
    inputs: {
      failureContext: { from: 'nodes.fetchPushedLogs.output' },
      previousCodeResult: { from: 'context.currentCodeResult' },
    },
    next: 'checkPushRetryFix',
    onFail: 'warn',
    step: 'executeCIFixImplementation',
    type: 'step',
  };
  nodes.checkPushRetryFix = {
    expr:
      'nodes.pushRetryFix.output == null || ' +
      'nodes.pushRetryFix.output.headSha == context.currentCodeResult.headSha',
    onFalse: 'keepPushRetryFix',
    onTrue: 'reportPushFailed',
    type: 'cond',
  };
  nodes.keepPushRetryFix = {
    next: 'pushFixAgain',
    type: 'set',
    values: { 'context.currentCodeResult': { from: 'nodes.pushRetryFix.output' } },
  };
  nodes.pushFixAgain = {
    config: { keepWorkBranch: true },
    inputs: {
      codeResult: { from: 'context.currentCodeResult' },
      triage: { from: 'context.ciTriage' },
    },
    next: 'checkPushedAgain',
    onFail: 'warn',
    step: 'pushCiFixToPullRequest',
    type: 'step',
  };
  nodes.checkPushedAgain = {
    expr: 'nodes.pushFixAgain.output.pushed == true',
    onFalse: 'reportPushFailed',
    onTrue: 'storePushedAgain',
    type: 'cond',
  };
  nodes.storePushedAgain = {
    next: 'reportPushed',
    type: 'set',
    values: { 'context.pushedCommitSha': { from: 'nodes.pushFixAgain.output.commitSha' } },
  };
  nodes.reportPushFailed = {
    inputs: {
      pushFailed: { literal: true },
      pushRetryAttempted: { expr: 'context.pushRetries >= 1' },
      pushRetryPushed: { expr: 'nodes.pushFixAgain.output.pushed == true' },
      pushRetryRefusedReason: { from: 'nodes.pushFixAgain.output.reason' },
      pushedCommitSha: pushed,
      triage: { from: 'context.ciTriage' },
      verification,
    },
    next: 'finishPushFailed',
    onFail: 'warn',
    step: 'reportCiTriage',
    type: 'step',
  };
  nodes.finishPushFailed = {
    next: 'pushFailed',
    onError: 'continue',
    step: 'finishCiFixPush',
    type: 'step',
  };
  nodes.pushFailed = {
    ...nodes.pushed,
    result: {
      ...(nodes.pushed as { result: Record<string, unknown> }).result,
      error: { literal: "the pushed fix did not pass the pull request's CI" },
      pushedCommitSha: pushed,
    },
    status: 'FAILED',
  };
  nodes.finishPushed = {
    next: 'pushed',
    onError: 'continue',
    step: 'finishCiFixPush',
    type: 'step',
  };
  nodes.pushed = {
    ...nodes.pushed,
    result: {
      ...(nodes.pushed as { result: Record<string, unknown> }).result,
      pushedCommitSha: pushed,
    },
  };
  return { ...g, nodes: nodes as WorkflowSpec['nodes'] };
}

const FAILURE_LESSONS_REASON =
  'a review or CI loop that runs out of attempts stores a lesson about what blocked it ' +
  'before the run fails';

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
  'agent-reviewed-pr': {
    apply: (g: WorkflowSpec) =>
      failureLessons(removePassThrough(g, 'setCompleted'), ['review', 'ci']),
    reason: `the finalizer already writes COMPLETED on SUCCESS; ${FAILURE_LESSONS_REASON}`,
  },
  'code-and-ci': {
    apply: (g: WorkflowSpec) => failureLessons(removePassThrough(g, 'setCompleted'), ['ci']),
    reason: `the finalizer already writes COMPLETED on SUCCESS; ${FAILURE_LESSONS_REASON}`,
  },
  'dependency-update': {
    apply: (g: WorkflowSpec) => failureLessons(removePassThrough(g, 'setCompleted'), ['ci']),
    reason: `the finalizer already writes COMPLETED on SUCCESS; ${FAILURE_LESSONS_REASON}`,
  },
  'default-engineering': {
    apply: (g: WorkflowSpec) =>
      defaultEngineeringFailureLessons(removePassThrough(g, 'setCompleted')),
    reason:
      'the finalizer already writes COMPLETED on SUCCESS; a review or CI loop that runs out ' +
      'of attempts, or a merge wait that times out, stores a lesson about what happened ' +
      'before the run ends, and every commitToMemory step names the outcome it records',
  },
  // The two templates that ended the run on the first CI failure now fix and retry like their
  // siblings, with CI ahead of the human / consensus gates (and the setCompleted removal above).
  'consensus-review': {
    apply: (g: WorkflowSpec) =>
      failureLessons(consensusReviewAfterCiFirst(removePassThrough(g, 'setCompleted')), [
        'review',
        'ci',
      ]),
    reason:
      'the finalizer already writes COMPLETED on SUCCESS; the PR opens straight after the ' +
      'implementation, a failing CI is fixed (2 attempts) before anything else, and the ' +
      'two-reviewer consensus runs on the green code, a rejection going fix -> CI -> consensus; ' +
      FAILURE_LESSONS_REASON,
  },
  'ci-triage-and-fix': {
    apply: (g: WorkflowSpec) => ciTriagePushWatch(ciTriageVerification(g)),
    reason:
      'a fix is checked against the failing step’s own command before it is delivered, and ' +
      'the result is reported with the fix; a fix pushed onto a pull request has its CI ' +
      'watched, with one follow-up attempt and a comment when it still fails',
  },
  'four-eyes': {
    apply: (g: WorkflowSpec) =>
      failureLessons(fourEyesAfterCiFirst(removePassThrough(g, 'setCompleted')), ['review', 'ci']),
    reason:
      'the finalizer already writes COMPLETED on SUCCESS; CI (with a 2-attempt fix loop) runs ' +
      'after the agent review and before the two sign-offs, which see the green code, and a ' +
      'rejection goes fix -> CI -> both sign-offs again instead of failing the run; the agent ' +
      'review and CI loops store a lesson when they run out of attempts (the sign-off loop does not)',
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
