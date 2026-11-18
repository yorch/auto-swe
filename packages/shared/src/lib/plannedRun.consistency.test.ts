import { describe, expect, it } from 'vitest';
import { runPlanConsistencyIssue } from './plannedRun.js';

const agentSpec = { nodes: { a: { agentRef: 'docs@2', type: 'agent' }, t: { type: 'terminate' } } };

describe('runPlanConsistencyIssue', () => {
  it('accepts a delivering plan without an agent and an output-only plan whose spec runs it', () => {
    expect(runPlanConsistencyIssue({ agentKey: null, mode: 'delivering' })).toBeNull();
    expect(
      runPlanConsistencyIssue({ agentKey: 'docs', mode: 'output-only' }, agentSpec)
    ).toBeNull();
  });

  it('refuses a delivering plan that names an agent', () => {
    expect(runPlanConsistencyIssue({ agentKey: 'docs', mode: 'delivering' })).toMatch(/delivering/);
  });

  it('refuses an output-only plan with no agent, or whose spec does not run the named agent', () => {
    expect(runPlanConsistencyIssue({ agentKey: null, mode: 'output-only' }, agentSpec)).toMatch(
      /must name/
    );
    expect(runPlanConsistencyIssue({ agentKey: '', mode: 'output-only' }, agentSpec)).toMatch(
      /must name/
    );
    expect(runPlanConsistencyIssue({ agentKey: 'other', mode: 'output-only' }, agentSpec)).toMatch(
      /no agent node/
    );
  });

  it('refuses an unknown mode', () => {
    expect(runPlanConsistencyIssue({ agentKey: null, mode: 'x' })).toMatch(/unknown/);
  });
});
