import type { FastifyInstance, FastifyReply } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validateRunConnection } from './runConnection.js';

const USER = {
  email: 'u@example.com',
  name: 'U',
  roles: ['ENGINEER'],
  sub: 'u1',
} as unknown as Parameters<typeof validateRunConnection>[0]['user'];

/** A connection row in the shape `findLaunchConnection` loads, for a given team. */
function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    installation: null,
    isActive: true,
    shares: [],
    team: {
      id: 'team-1',
      memberships: [{ userId: 'u1' }],
      organization: null,
      orgId: 'org-1',
    },
    teamId: 'team-1',
    type: 'confluence',
    ...overrides,
  };
}

function fakeReply() {
  return {
    send(body: unknown) {
      this.sent = body as { error?: { code?: string } };
      return this;
    },
    sent: undefined as { error?: { code?: string } } | undefined,
    sentStatus: 0,
    status(code: number) {
      this.sentStatus = code;
      return this;
    },
  };
}

const SCHEMA = {
  properties: {
    connectionId: { connectionType: 'issue_tracker', type: 'connection' as const },
    docConnectionId: { connectionType: 'confluence', type: 'connection' as const },
    issueId: { type: 'string' as const },
  },
  required: ['connectionId', 'docConnectionId', 'issueId'],
  type: 'object' as const,
};

describe('validateRunConnection — declared connections', () => {
  let findUnique: ReturnType<typeof vi.fn>;
  let findOrgMembership: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findUnique = vi.fn();
    findOrgMembership = vi.fn().mockResolvedValue({ id: 'm1' });
  });

  function run(input: Record<string, unknown>, reply: ReturnType<typeof fakeReply>) {
    return validateRunConnection(
      {
        gate: undefined,
        prisma: {
          connection: { findUnique: findUnique as unknown as () => Promise<unknown> },
          organizationMembership: { findUnique: findOrgMembership },
        } as unknown as FastifyInstance['prisma'],
        templateTeamId: 'team-1',
        user: null,
        ...input,
      } as Parameters<typeof validateRunConnection>[0],
      reply as unknown as FastifyReply
    );
  }

  it('refuses a declared connection belonging to another team', async () => {
    // Both rows exist. The second belongs to another team: the template-team rule
    // is what a public or webhook caller is held to, since there is no identity to
    // ask about membership.
    findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'jira-1'
        ? connectionRow({ id: 'jira-1', type: 'issue_tracker' })
        : connectionRow({
            id: 'wiki-1',
            team: { id: 'team-2', memberships: [], organization: null, orgId: 'org-2' },
            teamId: 'team-2',
            type: 'confluence',
          })
    );
    const reply = fakeReply();

    const result = await run(
      {
        connectionId: 'jira-1',
        inputSchema: SCHEMA,
        payload: { connectionId: 'jira-1', docConnectionId: 'wiki-1', issueId: 'P-1' },
      },
      reply
    );

    expect(result.ok).toBe(false);
    expect(reply.sentStatus).toBe(403);
    expect(reply.sent?.error?.code).toBe('FORBIDDEN');
  });

  it('refuses a declared connection that does not exist', async () => {
    findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'jira-1' ? connectionRow({ id: 'jira-1', type: 'issue_tracker' }) : null
    );
    const reply = fakeReply();

    const result = await run(
      {
        connectionId: 'jira-1',
        inputSchema: SCHEMA,
        payload: { connectionId: 'jira-1', docConnectionId: 'missing', issueId: 'P-1' },
      },
      reply
    );

    expect(result.ok).toBe(false);
    expect(reply.sentStatus).toBe(404);
    expect(reply.sent?.error?.code).toBe('CONNECTION_NOT_FOUND');
  });

  it('does not let a field repeat the run connection and skip its own type', async () => {
    findUnique.mockResolvedValue(connectionRow({ id: 'jira-1', type: 'issue_tracker' }));
    const reply = fakeReply();

    // Naming the same Jira connection as `docConnectionId` passes the access check
    // trivially; the field's own `confluence` contract still has to hold, or the
    // write would dispatch to the issue-tracker handler and create another issue.
    const result = await run(
      {
        connectionId: 'jira-1',
        inputSchema: SCHEMA,
        payload: { connectionId: 'jira-1', docConnectionId: 'jira-1', issueId: 'P-1' },
      },
      reply
    );

    expect(result.ok).toBe(false);
    expect(reply.sentStatus).toBe(400);
    expect(reply.sent?.error?.code).toBe('CONNECTION_TYPE_MISMATCH');
  });

  it('refuses a declared connection of the wrong type', async () => {
    findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'notion-1'
        ? connectionRow({ id: 'notion-1', type: 'notion' })
        : connectionRow({ id: where.id, type: 'issue_tracker' })
    );
    const reply = fakeReply();

    const result = await run(
      {
        connectionId: 'jira-1',
        inputSchema: SCHEMA,
        payload: { connectionId: 'jira-1', docConnectionId: 'notion-1', issueId: 'P-1' },
      },
      reply
    );

    expect(result.ok).toBe(false);
    expect(reply.sentStatus).toBe(400);
    expect(reply.sent?.error?.code).toBe('CONNECTION_TYPE_MISMATCH');
  });

  it('accepts a declared connection of the right team and type', async () => {
    findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      connectionRow({
        id: where.id,
        type: where.id === 'jira-1' ? 'issue_tracker' : 'confluence',
      })
    );
    const reply = fakeReply();

    const result = await run(
      {
        connectionId: 'jira-1',
        inputSchema: SCHEMA,
        payload: { connectionId: 'jira-1', docConnectionId: 'wiki-1', issueId: 'P-1' },
      },
      reply
    );

    expect(result.ok).toBe(true);
    expect(reply.sentStatus).toBe(0);
  });

  it('does not re-check the run-scoped connection as a declared one', async () => {
    findUnique.mockResolvedValue(connectionRow({ id: 'jira-1', type: 'issue_tracker' }));
    const reply = fakeReply();

    // `connectionId` is authorized as the run's target above; checking it again as
    // a declared field would look its id up a second time for no new decision.
    const result = await run(
      {
        connectionId: 'jira-1',
        inputSchema: SCHEMA,
        payload: { connectionId: 'jira-1', issueId: 'P-1' },
      },
      reply
    );

    expect(result.ok).toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('ignores a declared field the payload leaves out', async () => {
    findUnique.mockResolvedValue(connectionRow({ id: 'jira-1', type: 'issue_tracker' }));
    const reply = fakeReply();

    // An optional second connection the request did not name resolves to nothing,
    // so there is no credential to authorize and no extra lookup to make.
    const result = await run(
      { connectionId: 'jira-1', inputSchema: SCHEMA, payload: { issueId: 'P-1' } },
      reply
    );

    expect(result.ok).toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('refuses a second connection the launcher cannot reach', async () => {
    findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'jira-1'
        ? connectionRow({ id: 'jira-1', type: 'issue_tracker' })
        : // Another team's connection: the acting user is in no membership list and
          // it is not shared with them.
          connectionRow({
            id: 'wiki-1',
            team: { id: 'team-2', memberships: [], organization: null, orgId: null },
            type: 'confluence',
          })
    );
    const reply = fakeReply();

    const result = await run(
      {
        connectionId: 'jira-1',
        inputSchema: SCHEMA,
        payload: { connectionId: 'jira-1', docConnectionId: 'wiki-1', issueId: 'P-1' },
        user: USER,
      },
      reply
    );

    expect(result.ok).toBe(false);
    expect(reply.sentStatus).toBe(403);
  });
});
