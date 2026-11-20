import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from '../spec.js';
import { prWithoutReviewNodes } from './prNoReviewNodes.js';

/**
 * Tailored for dependency bumps: implement → full test suite → open PR → CI loop.
 * Skips the expensive review network (the diff is typically mechanical); tests
 * and CI are the real quality gate. Up to 3 CI-fix attempts before giving up.
 */
export const DEPENDENCY_UPDATE_SPEC: WorkflowSpec = {
  description:
    'Implement the dependency update, run the full test suite, open a pull request, then ' +
    'fix CI failures from the logs and push, up to 3 times. Skips the agent review: tests ' +
    'and CI are the quality gate for mechanical dependency bumps.',
  entry: 'validate',
  name: 'dependency-update',
  ...prWithoutReviewNodes(['runTests']),
  schemaVersion: SPEC_SCHEMA_VERSION,
};
