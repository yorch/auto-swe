import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinearProvider } from './linear.js';

/**
 * `transitionIssue` was a no-op ("Linear uses state names differently"), which
 * silently disabled every status sync on Linear workspaces. Linear has no
 * transitions endpoint: an issue moves by having `stateId` set to one of its
 * team's workflow states, and teams name those states freely — so resolution
 * has to fall back from an exact name match to the state's canonical `type`.
 */

const STATES = [
  { id: 'st-backlog', name: 'Backlog', type: 'backlog' },
  { id: 'st-todo', name: 'Todo', type: 'unstarted' },
  { id: 'st-building', name: 'Building', type: 'started' },
  { id: 'st-shipped', name: 'Shipped', type: 'completed' },
  { id: 'st-dropped', name: 'Dropped', type: 'canceled' },
];

let fetchMock: ReturnType<typeof vi.fn>;

/** Captures each GraphQL call as { query, variables }. */
function mockLinear(currentStateId = 'st-todo') {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ query: body.query, variables: body.variables });
    if (body.query.includes('IssueStates')) {
      return {
        json: async () => ({
          data: {
            issue: {
              id: 'iss-1',
              state: { id: currentStateId, name: 'Todo' },
              team: { states: { nodes: STATES } },
            },
          },
        }),
        ok: true,
      };
    }
    return { json: async () => ({ data: { issueUpdate: { success: true } } }), ok: true };
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

const provider = () => new LinearProvider('lin_api_test', {});
const updateCall = (calls: { query: string; variables: Record<string, unknown> }[]) =>
  calls.find((c) => c.query.includes('IssueUpdateState'));

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LinearProvider.transitionIssue', () => {
  it('matches a state by exact name, case-insensitively', async () => {
    const calls = mockLinear();
    await provider().transitionIssue('iss-1', 'building');
    expect(updateCall(calls)?.variables).toEqual({ id: 'iss-1', stateId: 'st-building' });
  });

  it.each([
    ['In Progress', 'st-building'],
    ['In Review', 'st-building'],
    ['Done', 'st-shipped'],
    ['Merged', 'st-shipped'],
    ['Cancelled', 'st-dropped'],
    ['Backlog', 'st-backlog'],
  ])('maps %j through the canonical state type', async (status, expectedId) => {
    const calls = mockLinear();
    await provider().transitionIssue('iss-1', status);
    expect(updateCall(calls)?.variables).toEqual({ id: 'iss-1', stateId: expectedId });
  });

  it('no-ops when the issue is already in the target state', async () => {
    const calls = mockLinear('st-building');
    await provider().transitionIssue('iss-1', 'In Progress');
    expect(updateCall(calls)).toBeUndefined();
  });

  it('no-ops on a status with no name match and no type mapping', async () => {
    const calls = mockLinear();
    await provider().transitionIssue('iss-1', 'Awaiting Legal Review');
    expect(updateCall(calls)).toBeUndefined();
  });

  it('swallows API failures rather than failing the run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500 }))
    );
    await expect(provider().transitionIssue('iss-1', 'Done')).resolves.toBeUndefined();
  });
});

describe('LinearProvider.syncOnEvent', () => {
  it.each([
    ['workflow_started', 'st-building'],
    ['workflow_completed', 'st-shipped'],
  ])('transitions on %s', async (type, expectedId) => {
    const calls = mockLinear();
    await provider().syncOnEvent({ issueId: 'iss-1', type } as never);
    expect(updateCall(calls)?.variables).toEqual({ id: 'iss-1', stateId: expectedId });
  });
});
