import { describe, expect, it } from 'vitest';
import { CI_TRIAGE_TEMPLATE_NAME } from '../../lib/ciTrigger.js';
import type { Node } from '../spec.js';
import { validateSpec } from '../validateSpec.js';
import { CI_TRIAGE_AND_FIX_SPEC } from './ciTriageAndFix.js';
import { BUILTIN_TEMPLATES } from './index.js';

const implementerSteps = new Set([
  'executeImplementation',
  'executeCIFixImplementation',
  'executeReviewFixImplementation',
  'executeGateFixImplementation',
]);

describe('ci-triage-and-fix', () => {
  it('is the template a CI-failure trigger starts by name', () => {
    expect(CI_TRIAGE_AND_FIX_SPEC.name).toBe(CI_TRIAGE_TEMPLATE_NAME);
    expect(BUILTIN_TEMPLATES.some((t) => t.name === CI_TRIAGE_TEMPLATE_NAME)).toBe(true);
  });

  it('refuses workflow-file changes on every implementer step, the CI loop fix included', () => {
    const steps = Object.entries(CI_TRIAGE_AND_FIX_SPEC.nodes).filter(
      ([, n]) => n.type === 'step' && implementerSteps.has(n.step)
    );
    expect(steps.map(([id]) => id).sort()).toEqual(['ciFix', 'implement']);
    for (const [, node] of steps) {
      expect((node as Extract<Node, { type: 'step' }>).config).toMatchObject({
        refuseWorkflowChanges: true,
      });
    }
  });

  it('hands the diagnosis to the implementer as untrusted data, never as guidance', () => {
    const implement = CI_TRIAGE_AND_FIX_SPEC.nodes.implement as Extract<Node, { type: 'step' }>;
    expect(implement.inputs).toHaveProperty('ciDiagnosis');
    expect(implement.inputs).not.toHaveProperty('guidance');
  });

  it('opens the fix as a draft', () => {
    const openPR = CI_TRIAGE_AND_FIX_SPEC.nodes.openPR as Extract<Node, { type: 'step' }>;
    expect(openPR.config).toMatchObject({ draft: true });
  });

  it('validates', () => {
    const result = validateSpec(CI_TRIAGE_AND_FIX_SPEC);
    expect(result.errors).toEqual([]);
  });
});
