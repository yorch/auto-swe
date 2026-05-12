/**
 * Lightweight factories for tests across the workflow package + downstream
 * consumers (web, gateway). Kept out of the public package barrel — import
 * directly via `@auto-swe/shared/workflow/testHelpers`.
 */
import { SPEC_SCHEMA_VERSION, type WorkflowSpec } from './spec.js';

export function makeSpec(partial: Partial<WorkflowSpec>): WorkflowSpec {
  return {
    description: '',
    entry: 'start',
    name: 'test',
    nodes: {},
    schemaVersion: SPEC_SCHEMA_VERSION,
    ...partial,
  } as WorkflowSpec;
}
