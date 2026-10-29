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

describe('LinearProvider.addComment', () => {
  it('reports a comment Linear accepted as posted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({ data: { commentCreate: { success: true } } }),
        ok: true,
      }))
    );
    await expect(provider().addComment('iss-1', 'hi')).resolves.toBe(true);
  });

  it.each([
    ['an HTTP failure', { ok: false, status: 500 }],
    [
      'a refused mutation',
      { json: async () => ({ data: { commentCreate: { success: false } } }), ok: true },
    ],
    ['a GraphQL error', { json: async () => ({ errors: [{ message: 'nope' }] }), ok: true }],
  ])('reports %s as not posted, without throwing', async (_label, response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response)
    );
    await expect(provider().addComment('iss-1', 'hi')).resolves.toBe(false);
  });
});

describe('LinearProvider.searchIssues', () => {
  it('is not supported: polling a filter is Jira only', async () => {
    await expect(provider().searchIssues('x', { maxResults: 5 })).rejects.toThrow(
      'searchIssues is not supported by the Linear provider'
    );
  });
});

describe('LinearProvider.readIssue failure classes', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stub = (impl: () => Promise<unknown>) => vi.stubGlobal('fetch', vi.fn(impl));

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate_limited'],
    [500, 'server_error'],
    [400, 'rejected'],
  ] as const)('maps HTTP %i to %s', async (status, failure) => {
    stub(async () => ({ json: async () => ({}), ok: false, status }));
    expect(await provider().readIssue('ENG-1')).toEqual({ failure, issue: null });
  });

  it.each([
    ['AUTHENTICATION_ERROR', 'unauthorized'],
    ['FORBIDDEN', 'forbidden'],
    ['RATELIMITED', 'rate_limited'],
    ['SOMETHING_NEW', 'rejected'],
  ] as const)(
    'reads the GraphQL error code %s of a 400 as %s, never its message',
    async (code, failure) => {
      stub(async () => ({
        json: async () => ({
          errors: [{ extensions: { code }, message: 'Bearer lin_api_SECRET is invalid' }],
        }),
        ok: false,
        status: 400,
      }));
      const result = await provider().readIssue('ENG-1');
      expect(result).toEqual({ failure, issue: null });
      expect(JSON.stringify(result)).not.toContain('SECRET');
    }
  );

  it('keeps the HTTP status class when the error body is unreadable', async () => {
    stub(async () => ({
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
      ok: false,
      status: 400,
    }));
    expect((await provider().readIssue('ENG-1')).failure).toBe('rejected');
  });

  it('calls a 200 with an unparseable body unknown, not a network failure', async () => {
    stub(async () => ({
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
      ok: true,
      status: 200,
    }));
    expect((await provider().readIssue('ENG-1')).failure).toBe('unknown');
  });

  it('maps a missing issue to not_found', async () => {
    stub(async () => ({ json: async () => ({ data: { issue: null } }), ok: true, status: 200 }));
    expect((await provider().readIssue('ENG-1')).failure).toBe('not_found');
  });

  it('maps a timeout and any other throw', async () => {
    stub(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect((await provider().readIssue('ENG-1')).failure).toBe('timeout');
    stub(async () => {
      throw new TypeError('fetch failed');
    });
    expect((await provider().readIssue('ENG-1')).failure).toBe('network');
  });

  it('keeps fetchIssue returning null on a failure', async () => {
    stub(async () => ({ json: async () => ({}), ok: false, status: 403 }));
    expect(await provider().fetchIssue('ENG-1')).toBeNull();
  });
});
