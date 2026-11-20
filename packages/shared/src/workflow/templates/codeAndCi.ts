import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { prWithoutReviewNodes } from './prNoReviewNodes.js';

/**
 * Fully automated fast path: implement → local quality gates → open PR → CI loop.
 * No review network, no HITL. Fastest possible route from ticket to open PR.
 */
export const CODE_AND_CI_SPEC: WorkflowSpec = {
  description:
    'Fully automated: implement the change, run lint, type checks and tests, open a pull ' +
    'request, then fix CI failures from the logs and push, up to 3 times. No agent review ' +
    'and no human approval. Use for low-risk, well-tested codebases.',
  entry: 'validate',
  name: 'code-and-ci',
  ...prWithoutReviewNodes(['runLint', 'runTypecheck', 'runTests']),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
