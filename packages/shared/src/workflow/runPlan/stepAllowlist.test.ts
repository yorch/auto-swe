import { describe, expect, it } from 'vitest';
import { BUILTIN_STEPS } from '../registry-types.js';
import { listAllSteps } from '../stepRegistry.js';
import {
  classifyRunPlanStep,
  isRunPlanStepAllowed,
  RUN_PLAN_DENIED_NODE_TYPES,
  RUN_PLAN_DENIED_STEPS,
  RUN_PLAN_FREE_STEPS,
  RUN_PLAN_SKELETON_STEPS,
  runPlanStepRefusal,
} from './stepAllowlist.js';

const registered = listAllSteps().map((s) => s.name);

describe('run plan step allowlist', () => {
  it('classifies every registered step exactly once', () => {
    const unclassified = registered.filter((n) => classifyRunPlanStep(n) === 'unclassified');
    expect(
      unclassified,
      `registered steps missing from the run-plan allowlist (free, skeleton or denied): ${unclassified.join(', ')}`
    ).toEqual([]);
    const doubled = registered.filter(
      (n) =>
        [
          RUN_PLAN_FREE_STEPS.has(n),
          RUN_PLAN_SKELETON_STEPS.has(n),
          Object.hasOwn(RUN_PLAN_DENIED_STEPS, n),
        ].filter(Boolean).length !== 1
    );
    expect(doubled).toEqual([]);
  });

  it('covers every builtin step name', () => {
    for (const name of BUILTIN_STEPS) {
      expect(classifyRunPlanStep(name), name).not.toBe('unclassified');
    }
  });

  it('names no step that is not registered', () => {
    const known = new Set(registered);
    const stale = [
      ...RUN_PLAN_FREE_STEPS,
      ...RUN_PLAN_SKELETON_STEPS,
      ...Object.keys(RUN_PLAN_DENIED_STEPS),
    ].filter((n) => !known.has(n));
    expect(stale).toEqual([]);
  });

  it('gives every denial a reason', () => {
    for (const [name, reason] of Object.entries(RUN_PLAN_DENIED_STEPS)) {
      expect(reason.trim().length, name).toBeGreaterThan(10);
    }
    for (const [type, reason] of Object.entries(RUN_PLAN_DENIED_NODE_TYPES)) {
      expect(reason.trim().length, type).toBeGreaterThan(5);
    }
  });

  it('denies every step that pushes, posts, merges or starts runs', () => {
    for (const name of [
      'runContainerStep',
      'submitPrdWorkRequests',
      'runTool',
      'postTicketComment',
      'createTrackerItems',
      'publishOutcome',
      'writeOutcome',
      'mergeBranches',
      'applyRecipe',
      'pushCiFixToPullRequest',
      'publishReviewResult',
      'runAgentNode',
      'runEvalNode',
    ]) {
      expect(classifyRunPlanStep(name), name).toBe('denied');
      expect(isRunPlanStepAllowed(name, 'delivering'), name).toBe(false);
      expect(runPlanStepRefusal(name, 'output-only'), name).toContain(name);
    }
  });

  it('keeps repository steps out of output-only plans', () => {
    expect(isRunPlanStepAllowed('executeImplementation', 'delivering')).toBe(true);
    expect(isRunPlanStepAllowed('executeImplementation', 'output-only')).toBe(false);
    expect(isRunPlanStepAllowed('validateContext', 'output-only')).toBe(true);
  });

  it('refuses a name it has never heard of', () => {
    expect(isRunPlanStepAllowed('someNewStep', 'delivering')).toBe(false);
    expect(runPlanStepRefusal('someNewStep', 'delivering')).toContain('allowlist');
  });
});
