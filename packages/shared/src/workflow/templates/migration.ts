import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import {
  openPullRequest,
  prResult,
  statusStamp,
  storeCodeResult,
  terminate,
  validatePhase,
} from './authoring/index.js';

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
    ...validatePhase({ next: 'setImplementing', successCriteria: false }),

    setImplementing: statusStamp('IMPLEMENTING', 'implement', { group: 'implement' }),
    implement: {
      group: 'implement',
      next: 'storeMigrationCode',
      step: 'executeImplementation',
      title: 'Implement the migration',
      type: 'step',
    },
    storeMigrationCode: storeCodeResult('dryRunMigration', { group: 'implement' }),

    dryRunMigration: {
      // Customise image + command for your stack; the image must be on the
      // team's shell allowlist or the node is rejected when its container
      // launches, mid-run. This one shipped as `node:24-slim`, which is not a
      // built-in, so the template could never actually run as seeded.
      // The shell node returns { passed, summary, exitCode } — summary is shown
      // to the approver.
      command: 'yarn db:migrate --dry-run 2>&1',
      group: 'dry run',
      image: 'node:24-alpine',
      next: 'storeDryRunResult',
      onFail: 'warn',
      title: 'Dry-run the migration',
      type: 'shell',
    },
    storeDryRunResult: {
      group: 'dry run',
      next: 'reviewMigrationPlan',
      title: 'Keep the dry-run summary',
      type: 'set',
      values: { 'context.dryRunSummary': { from: 'nodes.dryRunMigration.output.summary' } },
    },

    reviewMigrationPlan: {
      contextFrom: 'context.dryRunSummary',
      description: 'Review the dry-run output above. Approve to open the PR, reject to discard.',
      group: 'approval',
      onApprove: 'openPR',
      onReject: 'terminateRejected',
      onTimeout: 'terminateTimedOut',
      timeout: '24h',
      title: 'Approve migration plan before opening PR',
      type: 'humanApproval',
    },
    terminateRejected: terminate('FAILED', { group: 'approval', title: 'Rejected' }),
    terminateTimedOut: terminate('TIMED_OUT', { group: 'approval', title: 'Approval timed out' }),

    ...openPullRequest({ next: 'done' }),
    done: terminate('SUCCESS', { result: prResult(), title: 'Done' }),
  },
  schemaVersion: SPEC_SCHEMA_VERSION,
};
