import type { PrismaClient } from '@auto-swe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { declaredConnectionProblem } from './declaredConnections.js';

const findMany = vi.fn();
const prisma = { connection: { findMany } } as unknown as PrismaClient;

/** A team's own connection, and one it has only through a share. */
const OWNED = 'aaaaaaaa-0000-4000-8000-000000000001';
const SHARED = 'bbbbbbbb-0000-4000-8000-000000000002';
const OTHER_TEAM = 'cccccccc-0000-4000-8000-000000000003';

const schema = {
  properties: {
    docConnectionId: { type: 'connection' as const },
    mode: { type: 'string' as const },
  },
  required: [],
  type: 'object' as const,
};

function rows(r: Array<Record<string, unknown>>) {
  findMany.mockResolvedValue(r);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('declaredConnectionProblem', () => {
  it('allows a connection the team owns', async () => {
    rows([{ id: OWNED, isActive: true, shares: [], teamId: 'team-1' }]);

    await expect(
      declaredConnectionProblem({
        inputSchema: schema,
        payload: { docConnectionId: OWNED },
        prisma,
        teamId: 'team-1',
      })
    ).resolves.toBeNull();
  });

  it('allows one shared with the team', async () => {
    // The team-level form of membership: a share is what lets a team's automation use another
    // team's connection, and it is the same rule `isRepoMember` applies to a person.
    rows([{ id: SHARED, isActive: true, shares: [{ teamId: 'team-1' }], teamId: 'team-9' }]);

    await expect(
      declaredConnectionProblem({
        inputSchema: schema,
        payload: { docConnectionId: SHARED },
        prisma,
        teamId: 'team-1',
      })
    ).resolves.toBeNull();
  });

  it('refuses another team’s connection', async () => {
    rows([{ id: OTHER_TEAM, isActive: true, shares: [], teamId: 'team-9' }]);

    await expect(
      declaredConnectionProblem({
        inputSchema: schema,
        payload: { docConnectionId: OTHER_TEAM },
        prisma,
        teamId: 'team-1',
      })
    ).resolves.toMatch(/docConnectionId/);
  });

  it('names the field but not the owner', async () => {
    // A refusal that said which team owns the connection would confirm a guessed id exists.
    rows([{ id: OTHER_TEAM, isActive: true, shares: [], teamId: 'team-9' }]);

    const problem = await declaredConnectionProblem({
      inputSchema: schema,
      payload: { docConnectionId: OTHER_TEAM },
      prisma,
      teamId: 'team-1',
    });

    expect(problem).not.toMatch(/team-9/);
    expect(problem).not.toMatch(new RegExp(OTHER_TEAM));
  });

  it('refuses an inactive connection, which the run could not load either', async () => {
    rows([{ id: OWNED, isActive: false, shares: [], teamId: 'team-1' }]);

    await expect(
      declaredConnectionProblem({
        inputSchema: schema,
        payload: { docConnectionId: OWNED },
        prisma,
        teamId: 'team-1',
      })
    ).resolves.toMatch(/docConnectionId/);
  });

  it('refuses an id that is not a connection at all', async () => {
    rows([]);

    await expect(
      declaredConnectionProblem({
        inputSchema: schema,
        payload: { docConnectionId: OWNED },
        prisma,
        teamId: 'team-1',
      })
    ).resolves.toMatch(/docConnectionId/);
  });

  it('does not re-check the field repeating the run’s own connection', async () => {
    // The caller has already decided that one — the engine decides it as its target repository,
    // a launch as its primary connection — and re-asking here would refuse a repository a team
    // automation acts on through a share.
    findMany.mockResolvedValue([]);

    await expect(
      declaredConnectionProblem({
        inputSchema: schema,
        payload: { docConnectionId: OTHER_TEAM },
        primaryConnectionId: OTHER_TEAM,
        prisma,
        teamId: 'team-1',
      })
    ).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('decides nothing when the payload declares no connection', async () => {
    await expect(
      declaredConnectionProblem({
        inputSchema: schema,
        payload: { mode: 'fix' },
        prisma,
        teamId: 'team-1',
      })
    ).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('decides nothing for a payload that is not an object', async () => {
    await expect(
      declaredConnectionProblem({
        inputSchema: schema,
        payload: null,
        prisma,
        teamId: 'team-1',
      })
    ).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('decides nothing when the template declares no readable schema', async () => {
    // The run's pin is computed from the same value and declares nothing either, so a node that
    // resolves a connection anyway is refused where it is used.
    await expect(
      declaredConnectionProblem({
        inputSchema: 'not-a-schema',
        payload: { docConnectionId: OWNED },
        prisma,
        teamId: 'team-1',
      })
    ).resolves.toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('loads exactly the declared ids', async () => {
    rows([{ id: OWNED, isActive: true, shares: [], teamId: 'team-1' }]);

    await declaredConnectionProblem({
      inputSchema: schema,
      payload: { docConnectionId: OWNED },
      prisma,
      teamId: 'team-1',
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [OWNED] } } })
    );
  });

  describe('parity with a launch on a declared connection', () => {
    /** A schema whose connection field requires a particular connection type. */
    const typed = {
      properties: {
        docConnectionId: { connectionType: 'confluence', type: 'connection' as const },
      },
      required: [],
      type: 'object' as const,
    };

    it('allows a connection of the declared type', async () => {
      rows([{ id: OWNED, isActive: true, shares: [], teamId: 'team-1', type: 'confluence' }]);

      await expect(
        declaredConnectionProblem({
          inputSchema: typed,
          payload: { docConnectionId: OWNED },
          prisma,
          teamId: 'team-1',
        })
      ).resolves.toBeNull();
    });

    it('refuses a connection whose type contradicts the field’s declaration', async () => {
      // A launch answers CONNECTION_TYPE_MISMATCH here; a fire that stayed silent would hand the
      // run a connection its own template says cannot serve that node.
      rows([{ id: OWNED, isActive: true, shares: [], teamId: 'team-1', type: 'notion' }]);

      await expect(
        declaredConnectionProblem({
          inputSchema: typed,
          payload: { docConnectionId: OWNED },
          prisma,
          teamId: 'team-1',
        })
      ).resolves.toMatch(/expects a confluence connection/);
    });

    it('refuses a retired GitHub installation, as a launch answers 409', async () => {
      rows([
        {
          id: OWNED,
          installation: { host: 'github.com', installationId: '1', isActive: false },
          isActive: true,
          shares: [],
          teamId: 'team-1',
          type: 'git_repo',
        },
      ]);

      await expect(
        declaredConnectionProblem({
          inputSchema: schema,
          payload: { docConnectionId: OWNED },
          prisma,
          teamId: 'team-1',
        })
      ).resolves.toMatch(/retired GitHub installation/);
    });

    it('checks the primary field’s declared type without looking it up', async () => {
      // The caller already decided that row, so only the declaration is left — and a launch fails
      // that mismatch, so a fire must not be the more permissive of the two.
      rows([]);

      await expect(
        declaredConnectionProblem({
          inputSchema: typed,
          payload: { docConnectionId: OWNED },
          primaryConnectionId: OWNED,
          primaryConnectionType: 'git_repo',
          prisma,
          teamId: 'team-1',
        })
      ).resolves.toMatch(/expects a confluence connection/);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('accepts the primary field when its declared type matches the row the caller decided', async () => {
      rows([]);

      await expect(
        declaredConnectionProblem({
          inputSchema: {
            properties: {
              docConnectionId: { connectionType: 'git_repo', type: 'connection' as const },
            },
            required: [],
            type: 'object',
          },
          payload: { docConnectionId: OWNED },
          primaryConnectionId: OWNED,
          primaryConnectionType: 'git_repo',
          prisma,
          teamId: 'team-1',
        })
      ).resolves.toBeNull();
      expect(findMany).not.toHaveBeenCalled();
    });
  });
});
