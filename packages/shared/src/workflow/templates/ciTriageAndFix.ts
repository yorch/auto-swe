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
    runTests: qualityGate('runTests', 'openPR', { group: 'verify' }),
  },
  // A draft into the failing branch: a release branch for a push, the author's branch for
  // a pull request. Nothing is pushed to either.
  openPullRequest({ draft: true, next: 'reportFix', resetCiRetries: true }),
  {
    reportFix: {
      group: 'pull request',
      inputs: {
        fixPrUrl: { from: 'context.prUrl' },
        triage: { from: 'context.ciTriage' },
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
      result: { ...prResult(), ...TRIAGE_RESULT },
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
    'many times as the trigger allows. Never ' +
    'changes workflow files. Started by a CI-failure trigger.',
  entry: 'triage',
  // A literal, not `CI_TRIAGE_TEMPLATE_NAME`: the site's template extraction reads it from
  // source. `ciTriageAndFix.test.ts` keeps the two equal.
  name: 'ci-triage-and-fix',
  nodes,
  schemaVersion: SPEC_SCHEMA_VERSION,
};
