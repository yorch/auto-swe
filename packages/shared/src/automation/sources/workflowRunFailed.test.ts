import { describe, expect, it } from 'vitest';
import { CI_TRIAGE_INPUT_SCHEMA } from '../../lib/ciTrigger.js';
import {
  workflowRunFailedSource as ci,
  WorkflowRunFailedFiltersSchema,
} from './workflowRunFailed.js';

const filters = WorkflowRunFailedFiltersSchema.parse({
  branchPatterns: ['main', 'release/*', '!release/legacy'],
  events: ['push'],
  workflowPatterns: ['.github/workflows/**'],
});
const facts = ci.tester.facts({
  branch: 'release/1.4',
  event: 'push',
  workflowPath: '.github/workflows/ci.yml',
});

describe('workflowRunFailedSource', () => {
  it('matches by event, branch and workflow file, and says which part rules one out', () => {
    expect(ci.mismatch(filters, facts)).toBeNull();
    expect(ci.mismatch(filters, { ...facts, event: 'pull_request' })).toMatch(/pull requests/);
    expect(ci.mismatch(filters, { ...facts, branch: 'release/legacy' })).toMatch(/branch/);
    expect(ci.mismatch(filters, { ...facts, workflowPath: 'x.yml' })).toMatch(/workflow file/);
  });

  it('reacts to scheduled runs only when asked to, as a run on their branch', () => {
    const nightly = { ...facts, branch: 'main', event: 'schedule' };
    expect(ci.mismatch(filters, nightly)).toMatch(/scheduled runs/);
    const withSchedule = WorkflowRunFailedFiltersSchema.parse({
      ...filters,
      events: ['push', 'schedule'],
    });
    expect(ci.mismatch(withSchedule, nightly)).toBeNull();
    expect(ci.describe(withSchedule)).toMatch(/^pushes or scheduled runs on/);
    expect(ci.precondition?.(nightly)).toBeNull();
    expect(ci.samples(withSchedule).map((x) => [x.event, x.pullRequestNumber])).toEqual([
      ['push', null],
      ['schedule', null],
    ]);
  });

  it('decides per commit and counts limits per branch', () => {
    expect(ci.keys(facts)).toEqual({ scope: 'release/1.4', subject: 'a'.repeat(40) });
  });

  it('refuses filters with an empty or exclusion-only list, or an unknown event', () => {
    for (const bad of [
      { ...filters, branchPatterns: [] },
      { ...filters, branchPatterns: ['!main'] },
      { ...filters, events: ['pull_request_target'] },
    ]) {
      expect(WorkflowRunFailedFiltersSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('takes the built-in template, and not one that is not CI-aware', () => {
    expect(ci.templateCompatible(CI_TRIAGE_INPUT_SCHEMA)).toBe(true);
    expect(
      ci.templateCompatible({ properties: { description: { type: 'string' } }, type: 'object' })
    ).toBe(false);
    expect(
      ci.templateCompatible({
        properties: { githubRunId: { type: 'number' } },
        required: ['githubRunId'],
        type: 'object',
      })
    ).toBe(false);
  });
});
