import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';

/**
 * Database migration workflow: implement → dry-run migration in a shell
 * container → show the output to a human approver → open PR.
 *
 * The shell node runs `yarn db:migrate --dry-run` (customise the command for
 * your stack). The dry-run output is surfaced in the humanApproval `contextFrom`
 * field so the approver can see exactly what SQL will execute before signing off.
 *
 * Demonstrates: shell node + contextFrom on humanApproval.
 */
export const MIGRATION_SPEC: WorkflowSpec = {
  description:
    'Implement the migration code, execute a dry-run inside an ephemeral container ' +
    'to preview the SQL, then require a human to review and approve the plan before ' +
    'the PR is opened. Demonstrates the shell node paired with humanApproval contextFrom.',
  entry: 'setValidating',
  name: 'migration',
  nodes: {
    done: {
      result: {
        prNumber: { from: 'context.prNumber' },
        prUrl: { from: 'context.prUrl' },
      },
      status: 'SUCCESS',
      type: 'terminate',
    },
    dryRunMigration: {
      // Customise image + command for your stack; the image must be on the
      // team's shell allowlist or the node is rejected when its container
      // launches, mid-run. This one shipped as `node:24-slim`, which is not a
      // built-in, so the template could never actually run as seeded.
      // The shell node returns { passed, summary, exitCode } — summary is shown
      // to the approver.
      command: 'yarn db:migrate --dry-run 2>&1',
      image: 'node:24-alpine',
      next: 'storeDryRunResult',
      onFail: 'warn',
      type: 'shell',
    },
    implement: {
      next: 'storeMigrationCode',
      step: 'executeImplementation',
      type: 'step',
    },
    openPR: {
      inputs: { codeResult: { from: 'context.currentCodeResult' } },
      next: 'savePrInfo',
      step: 'createOrUpdatePullRequest',
      type: 'step',
    },
    reviewMigrationPlan: {
      contextFrom: 'context.dryRunSummary',
      description: 'Review the dry-run output above. Approve to open the PR, reject to discard.',
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'Approve migration plan before opening PR',
      type: 'humanApproval',
    },
    savePrInfo: {
      next: 'done',
      type: 'set',
      values: {
        'context.prNumber': { from: 'nodes.openPR.output.prNumber' },
        'context.prUrl': { from: 'nodes.openPR.output.prUrl' },
      },
    },
    setImplementing: {
      config: { status: 'IMPLEMENTING' },
      next: 'implement',
      step: 'updateDomainState',
      type: 'step',
    },
    setValidating: {
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
      step: 'updateDomainState',
      type: 'step',
    },
    storeDryRunResult: {
      next: 'reviewMigrationPlan',
      type: 'set',
      values: {
        'context.dryRunSummary': { from: 'nodes.dryRunMigration.output.summary' },
      },
    },
    storeMigrationCode: {
      next: 'dryRunMigration',
      type: 'set',
      values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
    },
    terminateRejected: { status: 'FAILED', type: 'terminate' },
    terminateTimedOut: { status: 'TIMED_OUT', type: 'terminate' },
    validate: {
      next: 'setImplementing',
      onError: 'continue',
      step: 'validateContext',
      type: 'step',
    },
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
