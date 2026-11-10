import { PR_FEEDBACK_DEFAULTS } from '../../lib/prFeedback.js';
import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { mergeNodes, type NodeMap, qualityGate, terminate } from './authoring/index.js';

export { PR_FEEDBACK_INPUT_SCHEMA } from '../../lib/prFeedback.js';

/** What every outcome reports: the round, the origin and why it ended. */
const FEEDBACK_RESULT = {
  origin: { from: 'context.prFeedback.origin' },
  prNumber: { from: 'context.prFeedback.prNumber' },
  reason: { from: 'context.prFeedback.reason' },
  round: { from: 'context.prFeedback.round' },
} as const;

/** Every implementer step here refuses a change to `.github/workflows` or `.github/actions`. */
const REFUSE_WORKFLOW_CHANGES = { refuseWorkflowChanges: true } as const;

const nodes: NodeMap = mergeNodes({
  gather: {
    group: 'gather',
    next: 'routeDecision',
    step: 'gatherPrFeedback',
    storeAs: 'context.prFeedback',
    title: 'Gather the feedback round',
    type: 'step',
  },
  routeDecision: {
    expr: "context.prFeedback.decision == 'fix'",
    group: 'gather',
    onFalse: 'respondSkipped',
    onTrue: 'routeFixer',
    title: 'A round to run?',
    type: 'cond',
  },
  respondSkipped: {
    group: 'skip',
    inputs: {
      gather: { from: 'context.prFeedback' },
      skipReason: { from: 'nodes.gather.output.reason' },
    },
    next: 'skipped',
    onFail: 'warn',
    step: 'respondToPrFeedback',
    title: 'Say why nothing ran',
    type: 'step',
  },
  skipped: terminate('SKIPPED', { group: 'skip', result: FEEDBACK_RESULT }),

  routeFixer: {
    expr: "context.prFeedback.fixer == 'agent'",
    group: 'fix',
    onFalse: 'fix',
    onTrue: 'agentFix',
    status: 'ADDRESSING_FEEDBACK',
    title: 'Who opened the pull request?',
    type: 'cond',
  },
  // The pull request an agent run opened is followed up by that same agent: the original
  // task plus the fenced brief, a trusted container to gate, a push to the work branch.
  agentFix: {
    group: 'fix',
    inputs: { gather: { from: 'context.prFeedback' } },
    next: 'storeAgentFix',
    onFailure: 'fixFailed',
    step: 'runAgentPrFeedbackTask',
    title: 'Follow up with the same agent',
    type: 'step',
  },
  storeAgentFix: {
    group: 'fix',
    next: 'checkChanged',
    title: 'Keep the follow-up',
    type: 'set',
    values: {
      'context.currentCodeResult': { from: 'nodes.agentFix.output.codeResult' },
      'context.fixerText': { from: 'nodes.agentFix.output.text' },
    },
  },
  fix: {
    config: REFUSE_WORKFLOW_CHANGES,
    group: 'fix',
    inputs: { gather: { from: 'context.prFeedback' } },
    next: 'storeFix',
    onFailure: 'fixFailed',
    step: 'executePrFeedbackImplementation',
    storeAs: 'context.currentCodeResult',
    title: 'Address the feedback',
    type: 'step',
  },
  storeFix: {
    group: 'fix',
    next: 'runLint',
    title: 'Keep the fix',
    type: 'set',
    values: { 'context.fixerText': { from: 'nodes.fix.output.implementationNotes' } },
  },
  runLint: qualityGate('runLint', 'runTypecheck', { group: 'verify' }),
  runTypecheck: qualityGate('runTypecheck', 'runTests', { group: 'verify' }),
  runTests: qualityGate('runTests', 'checkChanged', { group: 'verify' }),
  fixFailed: {
    group: 'fix',
    next: 'respondFixFailed',
    title: 'Record that the fix failed',
    type: 'set',
    values: {
      'context.failReason': {
        literal: 'a fix was attempted but failed before it could be pushed',
      },
    },
  },
  respondFixFailed: {
    group: 'fix failed',
    inputs: {
      gather: { from: 'context.prFeedback' },
      skipReason: { from: 'context.failReason' },
    },
    next: 'cleanupFixFailed',
    onFail: 'warn',
    step: 'respondToPrFeedback',
    title: 'Say the fix failed',
    type: 'step',
  },
  cleanupFixFailed: {
    group: 'fix failed',
    inputs: { gather: { from: 'context.prFeedback' } },
    next: 'failedFix',
    onFail: 'warn',
    step: 'finishPrFeedbackPush',
    title: 'Remove the work branch',
    type: 'step',
  },
  failedFix: terminate('FAILED', { group: 'fix failed', result: FEEDBACK_RESULT }),

  checkChanged: {
    expr: 'context.currentCodeResult.filesChanged.length == 0',
    group: 'deliver',
    onFalse: 'pushFix',
    onTrue: 'respondNoChange',
    title: 'Did the round change anything?',
    type: 'cond',
  },
  respondNoChange: {
    group: 'no change',
    inputs: { gather: { from: 'context.prFeedback' } },
    next: 'cleanupNoChange',
    onFail: 'warn',
    step: 'respondToPrFeedback',
    title: 'Say nothing changed',
    type: 'step',
  },
  cleanupNoChange: {
    group: 'no change',
    inputs: { gather: { from: 'context.prFeedback' } },
    next: 'doneNoChange',
    onFail: 'warn',
    step: 'finishPrFeedbackPush',
    title: 'Remove the work branch',
    type: 'step',
  },
  doneNoChange: terminate('SUCCESS', { group: 'no change', result: FEEDBACK_RESULT }),

  // The fix lands on the pull request's own branch as a fast-forward; the step decides and
  // refuses with a reason for anything it may not do.
  pushFix: {
    // Kept for a follow-up while the run watches the pushed commit; `finishPush` ends it.
    config: { keepWorkBranch: true },
    group: 'deliver',
    inputs: {
      codeResult: { from: 'context.currentCodeResult' },
      gather: { from: 'context.prFeedback' },
    },
    next: 'checkPushed',
    onFailure: 'respondPushThrew',
    step: 'pushPrFeedbackToPullRequest',
    title: "Push the fix onto the pull request's branch",
    type: 'step',
  },
  checkPushed: {
    expr: 'nodes.pushFix.output.pushed == true',
    group: 'deliver',
    onFalse: 'respondPushRefused',
    onTrue: 'storePush',
    title: 'Pushed?',
    type: 'cond',
  },
  respondPushThrew: {
    group: 'deliver',
    inputs: {
      gather: { from: 'context.prFeedback' },
      skipReason: { literal: 'the push could not be completed' },
    },
    next: 'cleanupRefused',
    onFail: 'warn',
    step: 'respondToPrFeedback',
    title: 'Say the push failed',
    type: 'step',
  },
  respondPushRefused: {
    group: 'deliver',
    inputs: {
      gather: { from: 'context.prFeedback' },
      skipReason: { from: 'nodes.pushFix.output.reason' },
    },
    next: 'cleanupRefused',
    onFail: 'warn',
    step: 'respondToPrFeedback',
    title: 'Say the push was refused',
    type: 'step',
  },
  cleanupRefused: {
    group: 'deliver',
    inputs: {
      gather: { from: 'context.prFeedback' },
      pushedCommitSha: { from: 'context.pushedCommitSha' },
    },
    next: 'failedPush',
    onFail: 'warn',
    step: 'finishPrFeedbackPush',
    title: 'Remove the work branch',
    type: 'step',
  },
  failedPush: terminate('FAILED', { group: 'deliver', result: FEEDBACK_RESULT }),
  storePush: {
    group: 'deliver',
    next: 'respondPushed',
    title: 'Record the push',
    type: 'set',
    values: { 'context.pushedCommitSha': { from: 'nodes.pushFix.output.commitSha' } },
  },
  respondPushed: {
    group: 'deliver',
    inputs: {
      diff: { from: 'context.currentCodeResult.diff' },
      fixerText: { from: 'context.fixerText' },
      gather: { from: 'context.prFeedback' },
      push: { from: 'nodes.pushFix.output' },
    },
    next: 'watchCi',
    onFail: 'warn',
    step: 'respondToPrFeedback',
    title: 'Answer each thread',
    type: 'step',
  },
  // The pull request's CI on the pushed commit, polled: a webhook for an author's branch
  // does not reach this run. A poll that cannot say (its deadline, no access) ends the
  // watch as it was.
  watchCi: {
    group: 'watch',
    inputs: { ref: { from: 'context.pushedCommitSha' } },
    next: 'checkCi',
    onFailure: 'respondCiUnknown',
    step: 'waitForCiByPolling',
    title: 'Watch the pull request’s CI on the fix',
    type: 'step',
  },
  checkCi: {
    expr: 'nodes.watchCi.output.ciPassed == false',
    group: 'watch',
    onFalse: 'respondCiOk',
    onTrue: 'checkRetry',
    title: 'Did the fix fail CI?',
    type: 'cond',
  },
  checkRetry: {
    expr: `(request.payload.maxCiFixAttempts ?? ${PR_FEEDBACK_DEFAULTS.maxCiFixAttempts}) == 0`,
    group: 'watch',
    onFalse: 'fetchLogs',
    onTrue: 'respondCiFailed',
    title: 'Allowed another attempt?',
    type: 'cond',
  },
  // One follow-up at most: the second entry goes to the report.
  fetchLogs: {
    group: 'watch',
    inputs: { logsUrl: { from: 'nodes.watchCi.output.logsUrl' } },
    maxVisits: 1,
    next: 'routeRetry',
    onExhausted: 'respondCiFailed',
    onFail: 'warn',
    step: 'fetchCILogs',
    title: 'Fetch the CI logs',
    type: 'step',
  },
  routeRetry: {
    expr: "context.prFeedback.fixer == 'agent'",
    group: 'watch',
    onFalse: 'retryFix',
    onTrue: 'retryAgentFix',
    title: 'Who fixes CI?',
    type: 'cond',
  },
  retryAgentFix: {
    group: 'watch',
    inputs: {
      ciLogs: { from: 'nodes.fetchLogs.output' },
      gather: { from: 'context.prFeedback' },
    },
    next: 'storeRetryAgent',
    onFailure: 'respondCiFailed',
    step: 'runAgentPrFeedbackTask',
    title: 'Fix CI with the same agent',
    type: 'step',
  },
  storeRetryAgent: {
    group: 'watch',
    next: 'pushAgain',
    title: 'Keep the follow-up',
    type: 'set',
    values: {
      'context.currentCodeResult': { from: 'nodes.retryAgentFix.output.codeResult' },
      'context.fixerText': { from: 'nodes.retryAgentFix.output.text' },
    },
  },
  retryFix: {
    // The pull request's own CI output: untrusted, redacted, screened and fenced.
    config: { ...REFUSE_WORKFLOW_CHANGES, untrustedCiLogs: true },
    group: 'watch',
    inputs: {
      failureContext: { from: 'nodes.fetchLogs.output' },
      previousCodeResult: { from: 'context.currentCodeResult' },
    },
    next: 'checkRetryFix',
    onFailure: 'respondCiFailed',
    step: 'executeCIFixImplementation',
    title: 'Fix the fix',
    type: 'step',
  },
  checkRetryFix: {
    expr: 'nodes.retryFix.output.headSha == context.currentCodeResult.headSha',
    group: 'watch',
    onFalse: 'storeRetryFix',
    onTrue: 'respondCiFailed',
    title: 'Did it change anything?',
    type: 'cond',
  },
  storeRetryFix: {
    group: 'watch',
    next: 'pushAgain',
    title: 'Keep the follow-up',
    type: 'set',
    values: {
      'context.currentCodeResult': { from: 'nodes.retryFix.output' },
      'context.fixerText': { from: 'nodes.retryFix.output.implementationNotes' },
    },
  },
  pushAgain: {
    config: { keepWorkBranch: true },
    group: 'watch',
    inputs: {
      codeResult: { from: 'context.currentCodeResult' },
      gather: { from: 'context.prFeedback' },
    },
    next: 'checkPushedAgain',
    onFailure: 'respondCiFailed',
    step: 'pushPrFeedbackToPullRequest',
    title: 'Push the follow-up',
    type: 'step',
  },
  checkPushedAgain: {
    expr: 'nodes.pushAgain.output.pushed == true',
    group: 'watch',
    onFalse: 'respondCiFailed',
    onTrue: 'storePushAgain',
    title: 'Pushed?',
    type: 'cond',
  },
  storePushAgain: {
    group: 'watch',
    next: 'watchCiAgain',
    title: 'Record the push',
    type: 'set',
    values: { 'context.pushedCommitSha': { from: 'nodes.pushAgain.output.commitSha' } },
  },
  watchCiAgain: {
    group: 'watch',
    inputs: { ref: { from: 'context.pushedCommitSha' } },
    next: 'checkCiAgain',
    onFailure: 'respondCiUnknown',
    step: 'waitForCiByPolling',
    title: 'Watch the pull request’s CI on the follow-up',
    type: 'step',
  },
  checkCiAgain: {
    expr: 'nodes.watchCiAgain.output.ciPassed == false',
    group: 'watch',
    onFalse: 'respondCiOk',
    onTrue: 'respondCiFailed',
    title: 'Did the follow-up pass CI?',
    type: 'cond',
  },

  respondCiUnknown: {
    group: 'watch',
    inputs: {
      ci: { literal: { verdict: 'unknown' } },
      gather: { from: 'context.prFeedback' },
      previous: { from: 'nodes.respondPushed.output.verdict' },
    },
    next: 'finishPush',
    onFail: 'warn',
    step: 'respondToPrFeedback',
    title: 'Report the round',
    type: 'step',
  },
  respondCiOk: {
    group: 'report ok',
    inputs: {
      ci: { literal: { verdict: 'passed' } },
      gather: { from: 'context.prFeedback' },
      previous: { from: 'nodes.respondPushed.output.verdict' },
      push: { from: 'nodes.pushFix.output' },
    },
    next: 'finishPush',
    onFail: 'warn',
    step: 'respondToPrFeedback',
    title: 'Report the round',
    type: 'step',
  },
  respondCiFailed: {
    group: 'report failed',
    inputs: {
      ci: { literal: { verdict: 'failed' } },
      gather: { from: 'context.prFeedback' },
      previous: { from: 'nodes.respondPushed.output.verdict' },
      push: { from: 'nodes.pushFix.output' },
    },
    next: 'finishPushFailed',
    onFail: 'warn',
    step: 'respondToPrFeedback',
    title: 'Report the round',
    type: 'step',
  },
  finishPush: {
    group: 'finish',
    inputs: {
      gather: { from: 'context.prFeedback' },
      pushedCommitSha: { from: 'context.pushedCommitSha' },
    },
    next: 'done',
    onFail: 'warn',
    step: 'finishPrFeedbackPush',
    title: 'Remove the work branch',
    type: 'step',
  },
  done: terminate('SUCCESS', {
    group: 'finish',
    result: {
      ...FEEDBACK_RESULT,
      pushedCommitSha: { from: 'context.pushedCommitSha' },
    },
  }),
  finishPushFailed: {
    group: 'report failed',
    inputs: {
      gather: { from: 'context.prFeedback' },
      pushedCommitSha: { from: 'context.pushedCommitSha' },
    },
    next: 'failed',
    onFail: 'warn',
    step: 'finishPrFeedbackPush',
    title: 'Remove the work branch',
    type: 'step',
  },
  failed: terminate('FAILED', { group: 'report failed', result: FEEDBACK_RESULT }),
});

/**
 * A pull-request feedback round, started by the `github.pull_request.feedback` automation:
 * the trigger re-read from the host, the member threads gathered and screened, fixed by the
 * review fixer — or by the agent that opened the pull request — pushed onto the pull request's
 * own branch, answered on the pull request, and followed up once when the pushed commit fails
 * the pull request's CI. Never changes workflow files.
 */
export const ADDRESS_PR_FEEDBACK_SPEC: WorkflowSpec = {
  description:
    'Address review feedback on a pull request the platform (or an agent run) opened — and, ' +
    'where an admin allows it, on another open pull request after an explicit /auto-swe fix ' +
    'command. Re-reads the trigger and the pull request from the host, gathers the member ' +
    'threads, fixes on a work branch and pushes it onto the pull request’s branch as a ' +
    'fast-forward, then reports the round on the pull request and follows up once when the ' +
    'pushed commit fails CI. Started by a pull-request feedback trigger.',
  entry: 'gather',
  // A literal, not `PR_FEEDBACK_TEMPLATE_NAME`: the site's template extraction reads it from
  // source. `addressPrFeedback.test.ts` keeps the two equal.
  name: 'address-pr-feedback',
  nodes,
  schemaVersion: SPEC_SCHEMA_VERSION,
};
