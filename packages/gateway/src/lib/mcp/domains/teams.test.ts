import { afterEach, describe, expect, it } from 'vitest';
import { buildMcpTestApp, INJECTION, type StubRoutes } from '../../../test/mcpHarness.js';

const TEAM = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const REPO = '33333333-3333-4333-8333-333333333333';

const teamRow = {
  _count: { memberships: 2, repositories: 1 },
  createdAt: '2026-01-01T00:00:00.000Z',
  defaultPersonaPrompt: INJECTION,
  description: INJECTION,
  id: TEAM,
  isActive: true,
  name: 'Pay​ments',
  orgId: 'org',
  slug: 'payments',
};

const teamDetail = {
  data: {
    ...teamRow,
    memberships: [
      { role: 'LEAD', user: { email: 'alice@example.com', id: USER, role: 'ADMIN' } },
      { role: 'SUPERUSER', user: { email: 'bob@example.com', id: REPO, role: 'ENGINEER' } },
    ],
    repositories: [
      { id: REPO, isActive: true, organizationName: 'acme', repoName: 'api', secret: INJECTION },
    ],
    sharedRepositories: [
      {
        id: REPO,
        isActive: true,
        organizationName: 'acme',
        repoName: 'web',
        team: { id: TEAM, name: 'Platform', slug: 'platform' },
      },
    ],
  },
};

const routes: StubRoutes = {
  'GET /api/v1/teams': { body: { data: [teamRow] } },
  'GET /api/v1/teams/:id': { body: teamDetail },
};

describe('the team tools', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });
  async function setup(r: StubRoutes = routes) {
    const built = await buildMcpTestApp(r);
    apps.push(built.app);
    return built;
  }

  it('lists teams with counts and returns neither descriptions nor persona prompts', async () => {
    const { callTool } = await setup();
    const { out, json } = await callTool('list_teams');
    expect(out).toEqual({
      teams: [{ id: TEAM, memberCount: 2, name: 'Payments', repositoryCount: 1, slug: 'payments' }],
    });
    expect(JSON.stringify(json)).not.toContain('IGNORE');
  });

  it('gets one team as user ids and team roles, never names or emails', async () => {
    const { callTool, seen } = await setup();
    const { out, json } = await callTool('get_team', { teamId: TEAM });
    expect(seen.urls).toContain(`/api/v1/teams/${TEAM}`);
    expect(out).toEqual({
      id: TEAM,
      // A role this server does not know degrades to the lowest rather than passing through.
      members: [
        { role: 'LEAD', userId: USER },
        { role: 'ENGINEER', userId: REPO },
      ],
      name: 'Payments',
      repositories: [{ id: REPO, isActive: true, organizationName: 'acme', repoName: 'api' }],
      sharedRepositories: [
        {
          id: REPO,
          isActive: true,
          organizationName: 'acme',
          owningTeam: { id: TEAM, name: 'Platform', slug: 'platform' },
          repoName: 'web',
        },
      ],
      slug: 'payments',
    });
    expect(JSON.stringify(json)).not.toMatch(/IGNORE|alice|bob|@example|secret|defaultPersona/);
  });

  it('refuses a team id that is not a uuid before any call is made', async () => {
    const { callTool, seen } = await setup();
    const { isError } = await callTool('get_team', { teamId: 'payments' });
    expect(isError).toBe(true);
    expect(seen.urls).toEqual([]);
  });

  it('answers a refusal with a fixed message, never the route text', async () => {
    const { callTool } = await setup({
      ...routes,
      'GET /api/v1/teams/:id': { body: {}, status: 403 },
    });
    const { json, isError } = await callTool('get_team', { teamId: TEAM });
    expect(isError).toBe(true);
    expect(json.result?.content[0]?.text).toBe('You are not permitted to do that.');
  });

  it('reports a malformed body as an unexpected response', async () => {
    const { callTool } = await setup({ ...routes, 'GET /api/v1/teams': { body: { data: 'x' } } });
    const { json, isError } = await callTool('list_teams');
    expect(isError).toBe(true);
    expect(json.result?.content[0]?.text).toBe('The platform returned an unexpected response.');
  });
});
