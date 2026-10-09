import { CI_TRIAGE_DEFAULTS } from '../../lib/ciTrigger.js';
import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  ciLoop,
  ciWaitEntry,
  mergeNodes,
  type NodeMap,
  openPullRequest,
  prResult,
  qualityGate,
  statusStamp,
  storeCodeResult,
  terminate,
} from './authoring/index.js';

/** What every outcome reports: the diagnosis and the run it was made for. */
const TRIAGE_RESULT = {
  category: { from: 'context.ciTriage.category' },
  confidence: { from: 'context.ciTriage.confidence' },
  decision: { from: 'context.ciTriage.decision' },
  reason: { from: 'context.ciTriage.reason' },
  rootCause: { from: 'context.ciTriage.rootCause' },
  run: { from: 'context.ciTriage.run' },
  suggestedFix: { from: 'context.ciTriage.suggestedFix' },
  summary: { from: 'context.ciTriage.summary' },
} as const;

/** Every implementer step here refuses a change to `.github/workflows` or `.github/actions`. */
const REFUSE_WORKFLOW_CHANGES = { refuseWorkflowChanges: true } as const;

export { CI_TRIAGE_INPUT_SCHEMA } from '../../lib/ciTrigger.js';

const nodes: NodeMap = mergeNodes(
  {
    triage: {
      group: 'triage',
      next: 'storeTriage',
      step: 'triageCiFailure',
      title: 'Diagnose the CI failure',
      type: 'step',
    },
    storeTriage: {
      group: 'triage',
      next: 'routeTriage',
      title: 'Keep the diagnosis',
      type: 'set',
      values: { 'context.ciTriage': { from: 'nodes.triage.output' } },
    },
    routeTriage: {
      expr: "context.ciTriage.decision == 'fix'",
      group: 'triage',
      onFalse: 'checkSkipped',
      onTrue: 'setImplementing',
      title: 'Attempt a fix?',
      type: 'cond',
    },
    checkSkipped: {
      expr: "context.ciTriage.decision == 'skip'",
      group: 'triage',
      onFalse: 'reportDiagnosis',
      onTrue: 'skipped',
      title: 'Not acted on?',
      type: 'cond',
    },
    reportDiagnosis: {
      group: 'report',
      inputs: { triage: { from: 'context.ciTriage' } },
      next: 'diagnosed',
      onFail: 'warn',
      step: 'reportCiTriage',
      title: 'Post the diagnosis on the pull request',
      type: 'step',
    },
    diagnosed: terminate('SUCCESS', {
      group: 'report',
      result: TRIAGE_RESULT,
      title: 'Diagnosed',
    }),
    skipped: terminate('SKIPPED', {
      group: 'triage',
      result: TRIAGE_RESULT,
      title: 'Not acted on',
    }),

    setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'fix' }),
    implement: {
      config: REFUSE_WORKFLOW_CHANGES,
      group: 'fix',
      // Fenced and labelled as untrusted data by the step, never as the requester's guidance.
      inputs: { ciDiagnosis: { from: 'context.ciTriage.brief' } },
      next: 'checkImplemented',
      // A refused change (a workflow file, the security gate) or any other failure still
      // posts the diagnosis, then ends the run FAILED.
      onFail: 'warn',
      step: 'executeImplementation',
      title: 'Fix the failure',
      type: 'step',
    },
    checkImplemented: {
      expr: 'nodes.implement.output == null',
      group: 'fix',
      onFalse: 'storeCodeResult',
      onTrue: 'implementFailed',
      title: 'Did the fix attempt fail?',
      type: 'cond',
    },
    implementFailed: {
      group: 'fix',
      next: 'reportFixFailed',
      title: 'Record that the fix failed',
      type: 'set',
      values: {
        'context.ciTriage.decision': { literal: 'report' },
        'context.ciTriage.reason': {
          literal: 'a fix was attempted but failed before a pull request was opened',
        },
      },
    },
    reportFixFailed: {
      group: 'fix',
      inputs: { triage: { from: 'context.ciTriage' } },
      next: 'fixFailed',
      onFail: 'warn',
      step: 'reportCiTriage',
      title: 'Post the diagnosis on the pull request',
      type: 'step',
    },
    fixFailed: terminate('FAILED', {
      group: 'fix',
      result: { ...TRIAGE_RESULT, error: { from: 'nodes.implement.error' } },
      title: 'Fix failed',
    }),
    storeCodeResult: storeCodeResult('checkChanged', { group: 'fix' }),
    checkChanged: {
      expr: 'context.currentCodeResult.filesChanged.length == 0',
      group: 'fix',
      onFalse: 'runLint',
      onTrue: 'noChange',
      title: 'Did the fix change anything?',
      type: 'cond',
    },
    noChange: {
      group: 'fix',
      next: 'reportDiagnosis',
      title: 'Record that nothing changed',
      type: 'set',
      values: {
        'context.ciTriage.decision': { literal: 'report' },
        'context.ciTriage.reason': {
          literal: 'the fix attempt changed no files, so no pull request was opened',
        },
      },
    },
    runLint: qualityGate('runLint', 'runTypecheck', { group: 'verify' }),
    runTypecheck: qualityGate('runTypecheck', 'runTests', { group: 'verify' }),
    runTests: qualityGate('runTests', 'verifyFix', { group: 'verify' }),
    // The failing step's own command, before and after the fix. It labels the fix (in the
    // pull request's body and the run's result); it never stops one from being delivered.
    verifyFix: {
      group: 'verify',
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
        triage: { from: 'context.ciTriage' },
      },
      next: 'storeVerification',
      onFail: 'warn',
      step: 'verifyCiFix',
      title: 'Reproduce the failure, then check the fix',
      type: 'step',
    },
    storeVerification: {
      expr: 'nodes.verifyFix.output == null',
      group: 'verify',
      onFalse: 'keepVerification',
      onTrue: 'routeDelivery',
      title: 'Did verification run?',
      type: 'cond',
    },
    keepVerification: {
      group: 'verify',
      next: 'routeDelivery',
      title: 'Keep the verification',
      type: 'set',
      values: {
        'context.ciVerification': { from: 'nodes.verifyFix.output.verification' },
        'context.currentCodeResult': { from: 'nodes.verifyFix.output.codeResult' },
      },
    },

    // A pull request's fix can be asked to land on its own branch. The step decides, from the
    // trigger, the admin setting and the branch as they are now; anything it refuses opens the
    // draft instead, so asking for a push never loses a fix.
    routeDelivery: {
      expr: "request.payload.pullRequestDelivery == 'push'",
      group: 'deliver',
      onFalse: 'openPR',
      onTrue: 'pushFix',
      title: 'Push to the pull request?',
      type: 'cond',
    },
    pushFix: {
      // Kept for a follow-up while the run watches the pushed commit; `finishCiFixPush` ends it.
      config: { keepWorkBranch: true },
      group: 'deliver',
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
        triage: { from: 'context.ciTriage' },
      },
      next: 'checkPushed',
      onFail: 'warn',
      step: 'pushCiFixToPullRequest',
      title: "Push the fix onto the pull request's branch",
      type: 'step',
    },
    checkPushed: {
      expr: 'nodes.pushFix.output.pushed == true',
      group: 'deliver',
      onFalse: 'openPR',
      onTrue: 'startPushWatch',
      title: 'Pushed?',
      type: 'cond',
    },
    startPushWatch: {
      group: 'deliver',
      next: 'reportPushed',
      title: 'Record the pushed fix',
      type: 'set',
      values: {
        'context.pushedCommitSha': { from: 'nodes.pushFix.output.commitSha' },
        'context.pushRetries': { literal: 0 },
      },
    },
    reportPushed: {
      group: 'deliver',
      inputs: {
        pushedCommitSha: { from: 'context.pushedCommitSha' },
        triage: { from: 'context.ciTriage' },
        verification: { from: 'context.ciVerification' },
      },
      next: 'watchPushedCi',
      onFail: 'warn',
      step: 'reportCiTriage',
      title: 'Report the pushed fix on the pull request',
      type: 'step',
    },
    // The pull request's CI on the pushed commit, polled: a webhook for an author's branch
    // does not reach this run. A poll that cannot say (its deadline, no access) ends the watch
    // as it was; the commit's later failure is the platform's own (`SUPPRESSED_OWN_OUTPUT`).
    watchPushedCi: {
      group: 'push CI',
      inputs: { ref: { from: 'context.pushedCommitSha' } },
      next: 'checkPushedCi',
      onError: 'continue',
      step: 'waitForCiByPolling',
      title: "Watch the pull request's CI on the fix",
      type: 'step',
    },
    checkPushedCi: {
      expr: 'nodes.watchPushedCi.output.ciPassed == false',
      group: 'push CI',
      onFalse: 'finishPushed',
      onTrue: 'checkPushRetries',
      title: 'Did the fix fail CI?',
      type: 'cond',
    },
    // One more attempt, unless the trigger allows no revisions at all.
    checkPushRetries: {
      expr: `context.pushRetries >= 1 || (request.payload.maxCiFixAttempts ?? ${CI_TRIAGE_DEFAULTS.maxCiFixAttempts}) == 0`,
      group: 'push CI',
      onFalse: 'countPushRetry',
      onTrue: 'reportPushFailed',
      title: 'Out of attempts?',
      type: 'cond',
    },
    countPushRetry: {
      group: 'push CI',
      next: 'fetchPushedLogs',
      title: 'Count the attempt',
      type: 'set',
      values: { 'context.pushRetries': { expr: 'context.pushRetries + 1' } },
    },
    fetchPushedLogs: {
      group: 'push CI',
      inputs: { logsUrl: { from: 'nodes.watchPushedCi.output.logsUrl' } },
      next: 'pushRetryFix',
      onFail: 'warn',
      step: 'fetchCILogs',
      title: 'Fetch the CI logs',
      type: 'step',
    },
    pushRetryFix: {
      // The pull request's own CI output: untrusted, as for the draft's CI loop.
      config: { ...REFUSE_WORKFLOW_CHANGES, untrustedCiLogs: true },
      group: 'push CI',
      inputs: {
        failureContext: { from: 'nodes.fetchPushedLogs.output' },
        previousCodeResult: { from: 'context.currentCodeResult' },
      },
      next: 'checkPushRetryFix',
      onFail: 'warn',
      step: 'executeCIFixImplementation',
      title: 'Fix the fix',
      type: 'step',
    },
    checkPushRetryFix: {
      expr:
        'nodes.pushRetryFix.output == null || ' +
        'nodes.pushRetryFix.output.headSha == context.currentCodeResult.headSha',
      group: 'push CI',
      onFalse: 'keepPushRetryFix',
      onTrue: 'reportPushFailed',
      title: 'Did the follow-up change nothing?',
      type: 'cond',
    },
    keepPushRetryFix: {
      group: 'push CI',
      next: 'pushFixAgain',
      title: 'Keep the follow-up',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.pushRetryFix.output' } },
    },
    pushFixAgain: {
      config: { keepWorkBranch: true },
      group: 'push CI',
      inputs: {
        codeResult: { from: 'context.currentCodeResult' },
        triage: { from: 'context.ciTriage' },
      },
      next: 'checkPushedAgain',
      onFail: 'warn',
      step: 'pushCiFixToPullRequest',
      title: "Push the follow-up onto the pull request's branch",
      type: 'step',
    },
    checkPushedAgain: {
      expr: 'nodes.pushFixAgain.output.pushed == true',
      group: 'push CI',
      onFalse: 'reportPushFailed',
      onTrue: 'storePushedAgain',
      title: 'Pushed?',
      type: 'cond',
    },
    storePushedAgain: {
      group: 'push CI',
      next: 'reportPushed',
      title: 'Record the follow-up',
      type: 'set',
      values: { 'context.pushedCommitSha': { from: 'nodes.pushFixAgain.output.commitSha' } },
    },
    reportPushFailed: {
      group: 'push CI',
      inputs: {
        pushFailed: { literal: true },
        // A follow-up was attempted, and whether it reached the branch (and failed CI too).
        pushRetryAttempted: { expr: 'context.pushRetries >= 1' },
        pushRetryPushed: { expr: 'nodes.pushFixAgain.output.pushed == true' },
        pushRetryRefusedReason: { from: 'nodes.pushFixAgain.output.reason' },
        pushedCommitSha: { from: 'context.pushedCommitSha' },
        triage: { from: 'context.ciTriage' },
        verification: { from: 'context.ciVerification' },
      },
      next: 'finishPushFailed',
      onFail: 'warn',
      step: 'reportCiTriage',
      title: 'Report that the pushed fix failed CI',
      type: 'step',
    },
    finishPushFailed: {
      group: 'push CI',
      next: 'pushFailed',
      onError: 'continue',
      step: 'finishCiFixPush',
      title: 'Remove the work branch',
      type: 'step',
    },
    pushFailed: terminate('FAILED', {
      group: 'push CI',
      result: {
        ...TRIAGE_RESULT,
        error: { literal: "the pushed fix did not pass the pull request's CI" },
        pushedCommitSha: { from: 'context.pushedCommitSha' },
        verification: { from: 'context.ciVerification' },
      },
      title: 'Pushed fix failed CI',
    }),
    finishPushed: {
      group: 'push CI',
      next: 'pushed',
      onError: 'continue',
      step: 'finishCiFixPush',
      title: 'Remove the work branch',
      type: 'step',
    },
    pushed: terminate('SUCCESS', {
      group: 'push CI',
      result: {
        ...TRIAGE_RESULT,
        pushedCommitSha: { from: 'context.pushedCommitSha' },
        verification: { from: 'context.ciVerification' },
      },
      title: 'Fix pushed',
    }),
  },
  // A draft into the failing branch: a release branch for a push, the author's branch for
  // a pull request. Nothing is pushed to either.
  openPullRequest({ draft: true, next: 'reportFix', resetCiRetries: true }),
  {
    reportFix: {
      group: 'pull request',
      inputs: {
        fixPrUrl: { from: 'context.prUrl' },
        // Why a requested push became this draft, when it did.
        pushRefusedReason: { from: 'nodes.pushFix.output.reason' },
        triage: { from: 'context.ciTriage' },
        verification: { from: 'context.ciVerification' },
      },
      next: ciWaitEntry('pollOrSignal'),
      onFail: 'warn',
      step: 'reportCiTriage',
      title: 'Link the fix from the pull request',
      type: 'step',
    },
  },
  // Polling as an option: a draft into a feature branch often runs no CI at all
  // (`on.pull_request.branches` names only main), and the poll reports that instead
  // of waiting four hours for a webhook that never comes.
  ciLoop({
    // The trigger's option, with the payload contract's default for a hand-started run. The
    // loop counts CI failures before checking (`incCIRetries` then `>=`), so N fixes need a
    // limit of N + 1: with 0 the first failure of the draft ends the run.
    fix: {
      handoff: { repush: 'repushAfterFix' },
      limit: `(request.payload.maxCiFixAttempts ?? ${CI_TRIAGE_DEFAULTS.maxCiFixAttempts}) + 1`,
      retryIfUnchanged: true,
    },
    passed: 'done',
    wait: 'pollOrSignal',
  }),
  {
    done: terminate('SUCCESS', {
      group: 'finish',
      result: {
        ...prResult(),
        ...TRIAGE_RESULT,
        verification: { from: 'context.ciVerification' },
      },
      title: 'Fix opened',
    }),
  }
);

// The CI loop's own fix step refuses workflow changes too…
const ciFix = nodes.ciFix;
if (ciFix?.type !== 'step') {
  throw new Error('ci-triage-and-fix: the CI loop has no ciFix step');
}
// …and its logs (the draft's own CI output) are untrusted input: redacted, screened for
// injection phrasing and fenced before the fixer sees them.
nodes.ciFix = {
  ...ciFix,
  config: { ...(ciFix.config ?? {}), ...REFUSE_WORKFLOW_CHANGES, untrustedCiLogs: true },
};

// After a fix is pushed, the wait starts over the way it first did: through the poll-or-signal
// router, not straight into the webhook wait (`ciLoop` re-enters `waitForCI`), so a deployment
// that only polls does not sit out four hours for a webhook that never comes.
const repush = nodes.repushAfterFix;
if (repush?.type !== 'step') {
  throw new Error('ci-triage-and-fix: the CI loop has no repushAfterFix step');
}
nodes.repushAfterFix = { ...repush, next: ciWaitEntry('pollOrSignal') };

/**
 * A failed GitHub Actions run, diagnosed, and — when the trigger allows it and
 * the diagnosis says code can fix it — fixed in a DRAFT pull request into the
 * branch that failed. Started by a CI-failure trigger, or by hand with a run id.
 */
export const CI_TRIAGE_AND_FIX_SPEC: WorkflowSpec = {
  description:
    'Diagnose a failed GitHub Actions run from its logs and classify it (regression, test bug, ' +
    'configuration, dependency, flaky, infrastructure). In fix mode, when code can fix it, open ' +
    'a draft pull request into the branch that failed and revise it while its own CI fails, as ' +
    "many times as the trigger allows — or, where allowed, push it onto a pull request's own branch. Never " +
    'changes workflow files. Started by a CI-failure trigger.',
  entry: 'triage',
  // A literal, not `CI_TRIAGE_TEMPLATE_NAME`: the site's template extraction reads it from
  // source. `ciTriageAndFix.test.ts` keeps the two equal.
  name: 'ci-triage-and-fix',
  nodes,
  schemaVersion: SPEC_SCHEMA_VERSION,
};
