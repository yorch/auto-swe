import { afterEach, describe, expect, it } from 'vitest';
import { buildMcpTestApp, INJECTION, type StubRoutes } from '../../../test/mcpHarness.js';

const AGENT = '11111111-1111-4111-8111-111111111111';
const AGENT_V1 = '22222222-2222-4222-8222-222222222222';
const SKILL = '33333333-3333-4333-8333-333333333333';
const USER = '55555555-5555-4555-8555-555555555555';
const CONN = '66666666-6666-4666-8666-666666666666';
const EMAIL = 'someone@example.com';

const agentsPath = 'GET /api/v1/platform/agent-library';
const versionsPath = 'GET /api/v1/platform/agent-library/:id/versions';
const skillsPath = 'GET /api/v1/platform/skills';

const agentRow = {
  channelId: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  createdById: USER,
  credentialId: CONN,
  description: INJECTION,
  harnessProfiles: [INJECTION],
  id: AGENT,
  inheritsModelFrom: null,
  isActive: true,
  isBuiltIn: true,
  isVerified: true,
  key: 'implementer',
  mcpConnectionId: CONN,
  modelSpec: 'anthropic/claude-opus-5-5',
  name: 'Implementer',
  orgId: USER,
  scope: 'GLOBAL',
  skillRefs: [{ skill: { id: SKILL, name: INJECTION } }],
  systemPrompt: INJECTION,
  teamId: null,
  toolKeys: ['bash', INJECTION],
  updatedAt: '2026-10-02T10:00:00.000Z',
  version: 3,
  workflowTemplateId: null,
};

const versionRow = {
  ...agentRow,
  createdByEmail: EMAIL,
  id: AGENT_V1,
  isActive: false,
  isVerified: false,
  version: 2,
};

const skillRow = {
  currentRevision: 4,
  description: INJECTION,
  externalSource: { host: 'github.com', owner: 'acme', repo: 'skills', sha: 'abc123' },
  id: SKILL,
  isActive: true,
  isBuiltIn: false,
  isVerified: true,
  name: 'tdd',
  promptText: INJECTION,
  scanWarnings: [{ message: INJECTION }, { message: EMAIL }],
  sourceId: CONN,
  usedBy: ['implementer', 'reviewer'],
  usedByCount: 2,
};

const routes: StubRoutes = {
  [agentsPath]: { body: { data: [agentRow] } },
  [versionsPath]: { body: { data: [versionRow, agentRow] } },
  [skillsPath]: { body: { data: [skillRow] } },
};

const forbidden = (json: unknown) => {
  const text = JSON.stringify(json);
  expect(text).not.toContain('IGNORE ALL PREVIOUS');
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain(CONN);
  expect(text).not.toContain('abc123');
};

describe('the library tools', () => {
  const apps: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });
  async function setup(r: StubRoutes = routes) {
    const built = await buildMcpTestApp(r);
    apps.push(built.app);
    return built;
  }

  it('lists agents without prompts, descriptions, tools or connection ids', async () => {
    const { callTool, seen } = await setup();
    const { out, json } = await callTool('list_agent_library', {
      all: false,
      scope: 'TEAM',
      teamId: USER,
    });
    expect(seen.queries[0]).toEqual({ all: 'false', scope: 'TEAM', teamId: USER });
    expect(out).toEqual({
      agents: [
        {
          channelId: null,
          createdAt: '2026-10-01T10:00:00.000Z',
          id: AGENT,
          isActive: true,
          isVerified: true,
          key: 'implementer',
          modelSpec: 'anthropic/claude-opus-5-5',
          name: 'Implementer',
          orgId: USER,
          scope: 'GLOBAL',
          teamId: null,
          updatedAt: '2026-10-02T10:00:00.000Z',
          version: 3,
          workflowTemplateId: null,
        },
      ],
    });
    forbidden(json);
  });

  it('degrades hostile agent fields instead of failing the call', async () => {
    const hostile = `${INJECTION} ${EMAIL}`.repeat(10);
    const { callTool } = await setup({
      ...routes,
      [agentsPath]: {
        body: {
          data: [
            { ...agentRow, key: hostile, modelSpec: hostile, name: hostile, scope: INJECTION },
          ],
        },
      },
    });
    const { out, isError } = await callTool('list_agent_library');
    expect(isError).toBe(false);
    const [agent] = (out?.agents ?? []) as Array<Record<string, string>>;
    expect(agent?.scope).toBe('unknown');
    expect(agent?.key).toBe([...hostile].slice(0, 130).join(''));
    expect(agent?.name).toBe([...hostile].slice(0, 200).join(''));
    expect(agent?.modelSpec).toBe([...hostile].slice(0, 200).join(''));
  });

  it('lists versions with the author id and never the email or prompt', async () => {
    const { callTool, seen } = await setup();
    const { out, json } = await callTool('list_agent_versions', { agentId: AGENT });
    expect(seen.urls).toEqual([`/api/v1/platform/agent-library/${AGENT}/versions`]);
    expect(out).toEqual({
      versions: [
        {
          createdAt: '2026-10-01T10:00:00.000Z',
          createdById: USER,
          id: AGENT_V1,
          isActive: false,
          isVerified: false,
          modelSpec: 'anthropic/claude-opus-5-5',
          version: 2,
        },
        {
          createdAt: '2026-10-01T10:00:00.000Z',
          createdById: USER,
          id: AGENT,
          isActive: true,
          isVerified: true,
          modelSpec: 'anthropic/claude-opus-5-5',
          version: 3,
        },
      ],
    });
    forbidden(json);
  });

  it('cleans a hostile model spec in a version and keeps a null author', async () => {
    const { callTool } = await setup({
      ...routes,
      [versionsPath]: {
        body: { data: [{ ...versionRow, createdById: null, modelSpec: `${INJECTION}‮\n` }] },
      },
    });
    const { out } = await callTool('list_agent_versions', { agentId: AGENT });
    const [v] = (out?.versions ?? []) as Array<Record<string, unknown>>;
    expect(v?.createdById).toBeNull();
    expect(v?.modelSpec).toBe(INJECTION);
  });

  it('says an unknown agent was not found', async () => {
    const { callTool, json } = await setup({
      ...routes,
      [versionsPath]: { body: {}, status: 404 },
    }).then(async ({ callTool }) => ({
      callTool,
      json: await callTool('list_agent_versions', { agentId: AGENT }),
    }));
    expect(json.isError).toBe(true);
    expect(json.json.result?.content[0]?.text).toBe('Agent not found.');
  });

  it('refuses an agent id that is not a uuid before any call is made', async () => {
    const { callTool, seen } = await setup();
    const { isError } = await callTool('list_agent_versions', { agentId: 'nope' });
    expect(isError).toBe(true);
    expect(seen.urls).toEqual([]);
  });

  it('lists skills with a warning count and no text', async () => {
    const { callTool, seen } = await setup();
    const { out, json } = await callTool('list_skills');
    expect(seen.urls).toEqual(['/api/v1/platform/skills']);
    expect(out).toEqual({
      skills: [
        {
          currentRevision: 4,
          externalSource: { host: 'github.com', owner: 'acme', repo: 'skills' },
          id: SKILL,
          isActive: true,
          isBuiltIn: false,
          isVerified: true,
          name: 'tdd',
          scanWarningCount: 2,
          usedBy: ['implementer', 'reviewer'],
          usedByCount: 2,
        },
      ],
    });
    forbidden(json);
  });

  it('cleans hostile skill names, sources and users, caps usedBy and tolerates missing fields', async () => {
    const hostile = `${INJECTION}‮ ${EMAIL}`.repeat(10);
    const many = Array.from({ length: 80 }, (_, i) => `agent${i}`);
    const { callTool } = await setup({
      ...routes,
      [skillsPath]: {
        body: {
          data: [
            {
              ...skillRow,
              externalSource: { host: hostile, owner: INJECTION, repo: `\u0000${INJECTION}` },
              name: hostile,
              usedBy: [hostile, ...many],
            },
            { ...skillRow, id: AGENT, isActive: undefined, scanWarnings: undefined },
          ],
        },
      },
    });
    const { out, isError } = await callTool('list_skills');
    expect(isError).toBe(false);
    const [a, b] = (out?.skills ?? []) as Array<Record<string, unknown>>;
    const clipped = (s: string, n: number) => [...s.replace('‮', '')].slice(0, n).join('');
    expect(a?.name).toBe(clipped(hostile.replaceAll('‮', ''), 200));
    expect(a?.externalSource).toEqual({
      host: clipped(hostile.replaceAll('‮', ''), 200),
      owner: INJECTION,
      repo: INJECTION,
    });
    const usedBy = a?.usedBy as string[];
    expect(usedBy).toHaveLength(50);
    expect(usedBy[0]).toBe(clipped(hostile.replaceAll('‮', ''), 130));
    expect(usedBy[1]).toBe('agent0');
    expect(b).toMatchObject({ isActive: null, scanWarningCount: 0 });
  });
});
