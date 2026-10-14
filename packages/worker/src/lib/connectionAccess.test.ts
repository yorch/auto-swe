import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@temporalio/activity', () => ({
  ApplicationFailure: {
    nonRetryable: (message: string, type?: string) => {
      const err = new Error(message) as Error & { type?: string };
      err.type = type;
      return err;
    },
  },
  Context: {
    current: vi.fn(() => ({ info: { workflowExecution: { workflowId: 'wf-1' } } })),
  },
}));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    connection: { findUnique: vi.fn() },
    workflowRun: { findUnique: vi.fn() },
  },
}));

const { prisma } = await import('@auto-swe/shared/db');
const { Context } = await import('@temporalio/activity');
const { assertRunMayUseConnection } = await import('./connectionAccess.js');

const CONNECTION_ID = '5af1a0ac-d2a0-4896-ad7e-ca8845e819c5';

/** The run's template belongs to `templateTeam`. */
function runOf(templateTeam: string | null) {
  (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    template: { teamId: templateTeam },
  });
}

function connectionOf(
  overrides: Partial<{ isActive: boolean; shares: { teamId: string }[]; teamId: string }> = {}
) {
  (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    isActive: true,
    shares: [],
    teamId: 'team-a',
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  (Context.current as ReturnType<typeof vi.fn>).mockReturnValue({
    info: { workflowExecution: { workflowId: 'wf-1' } },
  });
});

describe('assertRunMayUseConnection', () => {
  it('refuses a connection belonging to another team', async () => {
    runOf('team-a');
    connectionOf({ teamId: 'team-b' });

    // The hole this closes: an `mcp` node names a literal connection id, so without a
    // check here a template of one team calls tools on another team's server with that
    // team's token.
    await expect(assertRunMayUseConnection(CONNECTION_ID, 'mcp')).rejects.toThrow(
      'may not use connection'
    );
  });

  it('says nothing about whether the connection exists or who owns it', async () => {
    runOf('team-a');
    connectionOf({ teamId: 'team-b' });

    const refusal = await assertRunMayUseConnection(CONNECTION_ID, 'mcp').catch(
      (err: Error) => err.message
    );
    // A guessed id must learn nothing: the refusal names the node and the id the caller
    // supplied, and not the owning team, the connection's name or that it exists.
    expect(refusal).toBe(
      `Step 'mcp' may not use connection '${CONNECTION_ID}': it is not reachable from this run.`
    );
  });

  it('allows the owning team', async () => {
    runOf('team-a');
    connectionOf({ teamId: 'team-a' });

    await expect(assertRunMayUseConnection(CONNECTION_ID, 'mcp')).resolves.toBeUndefined();
  });

  it('allows a team the connection is shared with', async () => {
    runOf('team-a');
    connectionOf({ shares: [{ teamId: 'team-a' }], teamId: 'team-b' });

    await expect(assertRunMayUseConnection(CONNECTION_ID, 'mcp')).resolves.toBeUndefined();
  });

  it('allows any connection from a global template, which only an admin may author', async () => {
    runOf(null);
    connectionOf({ teamId: 'team-b' });

    await expect(assertRunMayUseConnection(CONNECTION_ID, 'mcp')).resolves.toBeUndefined();
  });

  it('refuses an inactive connection', async () => {
    runOf('team-a');
    connectionOf({ isActive: false, teamId: 'team-a' });

    await expect(assertRunMayUseConnection(CONNECTION_ID, 'mcp')).rejects.toThrow(
      'not reachable from this run'
    );
  });

  it('fails closed when the run cannot be identified', async () => {
    runOf('team-a');
    connectionOf({ teamId: 'team-a' });
    (prisma.workflowRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(assertRunMayUseConnection(CONNECTION_ID, 'mcp')).rejects.toThrow(
      'not reachable from this run'
    );
  });

  it('fails closed outside an activity context', async () => {
    connectionOf({ teamId: 'team-a' });
    (Context.current as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('activity context is not available');
    });

    await expect(assertRunMayUseConnection(CONNECTION_ID, 'mcp')).rejects.toThrow(
      'not reachable from this run'
    );
  });

  it('refuses a connection that does not exist', async () => {
    runOf('team-a');
    (prisma.connection.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(assertRunMayUseConnection(CONNECTION_ID, 'mcp')).rejects.toThrow(
      'not reachable from this run'
    );
  });
});
