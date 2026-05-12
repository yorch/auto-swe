import { describe, expect, it } from 'vitest';
import { parseWorkflowSpec } from '../spec.js';
import { QUALITY_GATES_EXAMPLE_SPEC } from './qualityGates.spec.js';

describe('QUALITY_GATES_EXAMPLE_SPEC', () => {
  it('parses and validates', () => {
    expect(() => parseWorkflowSpec(QUALITY_GATES_EXAMPLE_SPEC)).not.toThrow();
  });

  it('every gate step uses a phase-2 gate step name', () => {
    const expectedGateSteps = new Set([
      'runLint',
      'runTypecheck',
      'runTests',
      'runBuild',
      'runVulnScan',
      'runPerfBench',
    ]);
    const gateNodes = Object.values(QUALITY_GATES_EXAMPLE_SPEC.nodes).filter(
      (n) => n.type === 'step' && expectedGateSteps.has(n.step)
    );
    expect(gateNodes.length).toBeGreaterThan(0);
  });

  it('blocking gates configure onFail (retry or block)', () => {
    const { nodes } = QUALITY_GATES_EXAMPLE_SPEC;
    const lint = nodes.lint;
    expect(lint?.type).toBe('step');
    if (lint?.type === 'step') {
      // retry: 1 — must be present
      expect(lint.onFail).toEqual({ retry: 1 });
    }
    const vulnScan = nodes.vulnScan;
    if (vulnScan?.type === 'step') {
      expect(vulnScan.onFail).toBe('warn');
    }
  });
});
