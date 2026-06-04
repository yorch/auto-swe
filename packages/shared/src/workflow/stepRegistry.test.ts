import { describe, expect, it } from 'vitest';
import { BUILTIN_STEPS } from './registry-types.js';
import {
  assertBuiltinStepsRegistered,
  getStepMetadata,
  hasStep,
  listSteps,
} from './stepRegistry.js';

describe('stepRegistry', () => {
  it('registers every builtin step the worker promises to handle', () => {
    expect(() => assertBuiltinStepsRegistered()).not.toThrow();
    for (const name of BUILTIN_STEPS) {
      expect(hasStep(name)).toBe(true);
    }
  });

  it('exposes metadata for every registered step', () => {
    const all = listSteps();
    expect(all.length).toBeGreaterThanOrEqual(BUILTIN_STEPS.length);
    for (const meta of all) {
      expect(meta.name).toBeTypeOf('string');
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(['agent', 'gate', 'control', 'vcs', 'shell']).toContain(meta.category);
      expect(Array.isArray(meta.configFields)).toBe(true);
    }
  });

  it('throws on unknown step name', () => {
    expect(() => getStepMetadata('definitelyNotARealStep')).toThrow(/unknown step/);
  });

  it('categorizes the phase-2 quality gates correctly', () => {
    for (const gate of [
      'runLint',
      'runTypecheck',
      'runTests',
      'runBuild',
      'runVulnScan',
      'runPerfBench',
    ]) {
      expect(getStepMetadata(gate).category).toBe('gate');
    }
  });

  it('quality gates expose the command + timeoutMs config fields', () => {
    for (const gate of ['runLint', 'runTypecheck', 'runTests', 'runBuild']) {
      const fields = getStepMetadata(gate).configFields;
      const keys = fields.map((f) => f.key);
      expect(keys).toContain('command');
      expect(keys).toContain('timeoutMs');
    }
  });

  it('phase-3 decomposition steps are registered with sensible categories', () => {
    expect(getStepMetadata('planDecomposition').category).toBe('agent');
    expect(getStepMetadata('mergeBranches').category).toBe('vcs');
  });

  it('phase-3.5 resolveMergeConflict is registered as an agent step with attempt cap', () => {
    const meta = getStepMetadata('resolveMergeConflict');
    expect(meta.category).toBe('agent');
    const keys = meta.configFields.map((f) => f.key);
    expect(keys).toContain('maxAttemptsPerBranch');
    expect(keys).toContain('mergeMessagePrefix');
  });

  it('all agent steps expose a systemPrompt config field', () => {
    const agentSteps = listSteps().filter((s) => s.category === 'agent');
    for (const step of agentSteps) {
      const field = step.configFields?.find((f) => f.key === 'systemPrompt');
      expect(field, `${step.name} missing systemPrompt field`).toBeDefined();
      expect(field?.multiline).toBe(true);
    }
  });
});
