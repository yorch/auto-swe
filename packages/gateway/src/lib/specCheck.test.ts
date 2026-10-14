import {
  BUILTIN_SHELL_IMAGES,
  SPEC_SCHEMA_VERSION,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JwtPayload } from '../plugins/auth.js';
import {
  assertShellAuthoringAllowed,
  assertShellImagesAllowed,
  checkSpec,
  collectShellNodes,
  parseSpec,
  parseSpecOrThrow,
  type ShellNodeWithId,
  specErrorsOf,
  specValidationWarnings,
} from './specCheck.js';

const refs = vi.hoisted(() => ({ findSpecRefProblems: vi.fn() }));
vi.mock('./specRefValidation.js', () => ({ findSpecRefProblems: refs.findSpecRefProblems }));

const TEAM_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN = { role: 'ADMIN', sub: 'admin-1' } as JwtPayload;
const LEAD = { role: 'LEAD', sub: 'user-1' } as JwtPayload;

interface PrismaOpts {
  membership?: { role: string } | null;
  team?: { egressAllowlist: string[]; shellImageAllowlist: string[] } | null;
}

function fastifyWith(opts: PrismaOpts = {}) {
  const prisma = {
    team: { findUnique: vi.fn().mockResolvedValue(opts.team ?? null) },
    teamMembership: { findUnique: vi.fn().mockResolvedValue(opts.membership ?? null) },
  };
  return { fastify: { prisma } as unknown as FastifyInstance, prisma };
}

const shell = (id: string, image: string): ShellNodeWithId => ({
  id,
  node: { command: 'echo hi', image },
});

const done = { status: 'SUCCESS', type: 'terminate' };
const spec = (nodes: Record<string, unknown>, entry = 'start') => ({
  description: '',
  entry,
  name: 'spec',
  nodes,
  schemaVersion: SPEC_SCHEMA_VERSION,
});
const VALID = spec({ start: done });
const SHELL_SPEC = spec(
  { done, sh: { command: 'echo hi', image: 'alpine:latest', next: 'done', type: 'shell' } },
  'sh'
);

beforeEach(() => {
  vi.clearAllMocks();
  refs.findSpecRefProblems.mockResolvedValue([]);
});

describe('collectShellNodes', () => {
  it('returns no nodes for a spec with no shell-capable nodes', () => {
    const nodes = collectShellNodes({
      ...VALID,
      nodes: { start: { next: 'x', step: 'runLint', type: 'step' }, x: done },
    } as unknown as WorkflowSpec);
    expect(nodes).toEqual([]);
  });

  it('collects a first-class shell node with its command and image', () => {
    const nodes = collectShellNodes(SHELL_SPEC as unknown as WorkflowSpec);
    expect(nodes).toEqual([
      { id: 'sh', node: { command: 'echo hi', image: 'alpine:latest', network: undefined } },
    ]);
  });

  it('collects a containerStep node, defaulting a missing command to an empty string', () => {
    const s = spec({
      done,
      c: { image: 'python:3.13-alpine', network: 'none', next: 'done', type: 'containerStep' },
    });
    expect(collectShellNodes(s as unknown as WorkflowSpec)).toEqual([
      { id: 'c', node: { command: '', image: 'python:3.13-alpine', network: 'none' } },
    ]);
  });

  it('treats a plain step naming a shell-category step as shell', () => {
    const s = spec({
      done,
      s: {
        config: { command: 'ls', image: 'alpine:latest', network: 'egress' },
        next: 'done',
        step: 'runContainerStep',
        type: 'step',
      },
    });
    expect(collectShellNodes(s as unknown as WorkflowSpec)).toEqual([
      { id: 's', node: { command: 'ls', image: 'alpine:latest', network: 'egress' } },
    ]);
  });

  it('turns a non-string image on a step node into an empty image the allowlist refuses', () => {
    const s = spec({
      done,
      s: { config: { image: 42 }, next: 'done', step: 'runContainerStep', type: 'step' },
    });
    const [found] = collectShellNodes(s as unknown as WorkflowSpec);
    expect(found?.node.image).toBe('');
  });

  it('drops an unrecognised network value on a step node rather than passing it through', () => {
    const s = spec({
      done,
      s: {
        config: { image: 'alpine:latest', network: 'host' },
        next: 'done',
        step: 'runContainerStep',
        type: 'step',
      },
    });
    const [found] = collectShellNodes(s as unknown as WorkflowSpec);
    expect(found?.node.network).toBeUndefined();
  });

  it('collects a shell node that is only a fan-out branch entry', () => {
    const s = spec({
      done,
      fan: { concurrency: 2, join: 'done', over: 'items', subgraph: 'sh', type: 'fanOut' },
      sh: { command: 'echo', image: 'alpine:latest', type: 'shell' },
    });
    expect(collectShellNodes(s as unknown as WorkflowSpec).map((n) => n.id)).toEqual(['sh']);
  });
});

describe('assertShellAuthoringAllowed', () => {
  it('returns null without a membership lookup when there are no shell nodes', async () => {
    const { fastify, prisma } = fastifyWith();
    const result = await assertShellAuthoringAllowed(fastify, LEAD, TEAM_ID, []);
    expect(result).toBeNull();
    expect(prisma.teamMembership.findUnique).not.toHaveBeenCalled();
  });

  it('lets a platform ADMIN author shell nodes on a global template without a lookup', async () => {
    const { fastify, prisma } = fastifyWith();
    const result = await assertShellAuthoringAllowed(fastify, ADMIN, null, [shell('sh', 'x')]);
    expect(result).toBeNull();
    expect(prisma.teamMembership.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a non-platform-admin on a global template with SHELL_AUTHOR_FORBIDDEN', async () => {
    const { fastify, prisma } = fastifyWith({ membership: { role: 'ADMIN' } });
    const result = await assertShellAuthoringAllowed(fastify, LEAD, null, [shell('sh', 'x')]);
    expect(result).toEqual({
      body: {
        error: {
          code: 'SHELL_AUTHOR_FORBIDDEN',
          message: 'Only platform admins may author shell steps on global templates',
        },
      },
      statusCode: 403,
    });
    // A team-admin membership cannot unlock a global template.
    expect(prisma.teamMembership.findUnique).not.toHaveBeenCalled();
  });

  it('lets a team ADMIN of the owning team author shell nodes', async () => {
    const { fastify, prisma } = fastifyWith({ membership: { role: 'ADMIN' } });
    const result = await assertShellAuthoringAllowed(fastify, LEAD, TEAM_ID, [shell('sh', 'x')]);
    expect(result).toBeNull();
    expect(prisma.teamMembership.findUnique).toHaveBeenCalledWith({
      where: { userId_teamId: { teamId: TEAM_ID, userId: 'user-1' } },
    });
  });

  it('refuses a team member who is not a team ADMIN', async () => {
    const { fastify } = fastifyWith({ membership: { role: 'LEAD' } });
    const result = await assertShellAuthoringAllowed(fastify, LEAD, TEAM_ID, [shell('sh', 'x')]);
    expect(result).toEqual({
      body: {
        error: {
          code: 'SHELL_AUTHOR_FORBIDDEN',
          message: 'Authoring shell steps requires team-admin role',
        },
      },
      statusCode: 403,
    });
  });

  it('refuses a user with no membership in the owning team', async () => {
    const { fastify } = fastifyWith({ membership: null });
    const result = await assertShellAuthoringAllowed(fastify, LEAD, TEAM_ID, [shell('sh', 'x')]);
    expect(result).toMatchObject({ statusCode: 403 });
  });
});

describe('assertShellImagesAllowed', () => {
  it('passes with no egress allowlist and no team lookup for zero shell nodes', async () => {
    const { fastify, prisma } = fastifyWith();
    const result = await assertShellImagesAllowed(fastify, TEAM_ID, []);
    expect(result).toEqual({ egressAllowlist: [], ok: true });
    expect(prisma.team.findUnique).not.toHaveBeenCalled();
  });

  it.each([...BUILTIN_SHELL_IMAGES])('accepts the built-in image %s', async (image) => {
    const { fastify } = fastifyWith({ team: { egressAllowlist: [], shellImageAllowlist: [] } });
    const result = await assertShellImagesAllowed(fastify, TEAM_ID, [shell('sh', image)]);
    expect(result).toMatchObject({ ok: true });
  });

  it('accepts a team-allowlisted image and returns the team egress allowlist', async () => {
    const { fastify } = fastifyWith({
      team: { egressAllowlist: ['api.acme.test'], shellImageAllowlist: ['ghcr.io/acme/tool:1'] },
    });
    const result = await assertShellImagesAllowed(fastify, TEAM_ID, [
      shell('sh', 'ghcr.io/acme/tool:1'),
    ]);
    expect(result).toEqual({ egressAllowlist: ['api.acme.test'], ok: true });
  });

  it.each(['ghcr.io/acme/tool:2', 'ghcr.io/acme/tool'])(
    'refuses %s when only ghcr.io/acme/tool:1 is allowed',
    async (image) => {
      const { fastify } = fastifyWith({
        team: { egressAllowlist: [], shellImageAllowlist: ['ghcr.io/acme/tool:1'] },
      });
      const result = await assertShellImagesAllowed(fastify, TEAM_ID, [shell('sh', image)]);
      expect(result).toMatchObject({ ok: false, statusCode: 400 });
    }
  );

  it('refuses an unknown image with SHELL_IMAGE_NOT_ALLOWED naming the node', async () => {
    const { fastify } = fastifyWith({ team: { egressAllowlist: [], shellImageAllowlist: [] } });
    const result = await assertShellImagesAllowed(fastify, TEAM_ID, [
      shell('build', 'evil:latest'),
    ]);
    expect(result).toMatchObject({
      body: {
        error: {
          code: 'SHELL_IMAGE_NOT_ALLOWED',
          message: expect.stringMatching(/^Node 'build': image 'evil:latest' is not on the/),
        },
      },
      ok: false,
      statusCode: 400,
    });
  });

  it('refuses an empty image, which a non-string image is normalised to', async () => {
    const { fastify } = fastifyWith({ team: null });
    const result = await assertShellImagesAllowed(fastify, null, [shell('sh', '')]);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
  });

  it('reports the first refused node in order and stops there', async () => {
    const { fastify } = fastifyWith({ team: null });
    const result = await assertShellImagesAllowed(fastify, null, [
      shell('first', 'bad:1'),
      shell('second', 'worse:1'),
    ]);
    expect(result).toMatchObject({
      body: { error: { message: expect.stringMatching(/^Node 'first'/) } },
    });
  });

  it('refuses a custom image on a global template, which has no team allowlist', async () => {
    const { fastify, prisma } = fastifyWith();
    const built = await assertShellImagesAllowed(fastify, null, [shell('sh', 'alpine:latest')]);
    const custom = await assertShellImagesAllowed(fastify, null, [shell('sh', 'ghcr.io/x/y:1')]);
    expect(built).toMatchObject({ ok: true });
    expect(custom).toMatchObject({ ok: false, statusCode: 400 });
    expect(prisma.team.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a custom image when the owning team row cannot be found', async () => {
    const { fastify } = fastifyWith({ team: null });
    const result = await assertShellImagesAllowed(fastify, TEAM_ID, [
      shell('sh', 'ghcr.io/acme/tool:1'),
    ]);
    expect(result).toMatchObject({ ok: false, statusCode: 400 });
  });
});

describe('parseSpec', () => {
  it('refuses a non-object spec with SPEC_NOT_OBJECT', () => {
    for (const input of [null, 'spec', 7]) {
      expect(parseSpec(input)).toMatchObject({
        issues: [{ code: 'SPEC_NOT_OBJECT' }],
        ok: false,
      });
    }
  });

  it('refuses a spec at another schema version rather than upgrading it', () => {
    const result = parseSpec({ ...VALID, schemaVersion: 0 });
    expect(result).toEqual({
      issues: [
        {
          code: 'SCHEMA_VERSION',
          field: 'schemaVersion',
          message: `spec.schemaVersion must be ${SPEC_SCHEMA_VERSION} (got 0)`,
        },
      ],
      message: `spec.schemaVersion must be ${SPEC_SCHEMA_VERSION} (got 0)`,
      ok: false,
    });
  });

  it('accepts a valid spec and returns the parsed spec', () => {
    const result = parseSpec(VALID);
    expect(result.ok).toBe(true);
  });

  it('locates a schema failure by its node and field', () => {
    const result = parseSpec(spec({ start: { type: 'nope' } }));
    expect(result).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'SCHEMA_INVALID', field: 'type', nodeId: 'start' }),
      ]),
      ok: false,
    });
  });

  it('refuses an internal step in an authored spec with INTERNAL_STEP', () => {
    const result = parseSpec(
      spec({ done, s: { next: 'done', step: 'runAgentTask', type: 'step' } }, 's')
    );
    expect(result).toMatchObject({
      issues: [{ code: 'INTERNAL_STEP', field: 'step', nodeId: 's' }],
      ok: false,
    });
  });
});

describe('parseSpecOrThrow', () => {
  it('returns the parsed spec for a valid input', () => {
    expect(parseSpecOrThrow(VALID)).toMatchObject({ entry: 'start', name: 'spec' });
  });

  it('throws a 400-tagged error carrying the message parseSpec reports', () => {
    let thrown: unknown;
    try {
      parseSpecOrThrow({ ...VALID, schemaVersion: 0 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ statusCode: 400 });
    expect((thrown as Error).message).toBe(
      `spec.schemaVersion must be ${SPEC_SCHEMA_VERSION} (got 0)`
    );
  });
});

describe('specErrorsOf and specValidationWarnings', () => {
  // `a` loops on itself and never reaches a terminate node.
  const NO_TERMINAL = spec(
    { a: { command: 'x', image: 'alpine:latest', next: 'a', type: 'shell' } },
    'a'
  );

  it('reports no lint errors for a spec that terminates', () => {
    expect(specErrorsOf(VALID)).toEqual([]);
  });

  it('reports a lint error for a spec that cannot reach a terminate node', () => {
    const errors = specErrorsOf(NO_TERMINAL);
    expect(errors.some((e) => e.includes('no terminate node is reachable'))).toBe(true);
  });

  it('includes lint errors among the non-blocking save warnings', () => {
    const warnings = specValidationWarnings(NO_TERMINAL);
    expect(warnings.some((w) => w.includes('no terminate node is reachable'))).toBe(true);
  });
});

describe('checkSpec', () => {
  it('stops at the schema check, reporting only schema issues', async () => {
    const { fastify } = fastifyWith();
    const issues = await checkSpec(fastify, ADMIN, TEAM_ID, { ...VALID, schemaVersion: 0 });
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'SCHEMA_VERSION',
        field: 'schemaVersion',
        severity: 'error',
        source: 'schema',
      }),
    ]);
    expect(refs.findSpecRefProblems).not.toHaveBeenCalled();
  });

  it('reports an unresolved agent or mcp reference as a warning from the refs source', async () => {
    refs.findSpecRefProblems.mockResolvedValue([
      {
        code: 'AGENT_REF_UNRESOLVED',
        field: 'agentRef',
        message: "Node 'a': agent 'gone' has no active Agent at any scope",
        nodeId: 'a',
      },
    ]);
    const { fastify } = fastifyWith();
    const issues = await checkSpec(fastify, ADMIN, TEAM_ID, VALID);
    expect(issues).toContainEqual(
      expect.objectContaining({
        code: 'AGENT_REF_UNRESOLVED',
        nodeId: 'a',
        severity: 'warning',
        source: 'refs',
      })
    );
  });

  it('reports a lint error from validateSpec with the lint source', async () => {
    const { fastify } = fastifyWith();
    const issues = await checkSpec(
      fastify,
      ADMIN,
      TEAM_ID,
      spec({ a: { command: 'x', image: 'alpine:latest', next: 'a', type: 'shell' } }, 'a')
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'NO_TERMINAL', severity: 'error', source: 'lint' })
    );
  });

  it('reports a shell-authoring refusal for a non-admin with no node attached', async () => {
    const { fastify } = fastifyWith({ membership: { role: 'LEAD' } });
    const issues = await checkSpec(fastify, LEAD, TEAM_ID, SHELL_SPEC);
    expect(issues.filter((i) => i.source === 'authoring')).toEqual([
      {
        code: 'SHELL_AUTHOR_FORBIDDEN',
        message: 'Authoring shell steps requires team-admin role',
        severity: 'error',
        source: 'authoring',
      },
    ]);
  });

  it('reports a refused shell image against its node, with the node prefix stripped', async () => {
    const { fastify } = fastifyWith({ team: null });
    const bad = spec(
      { done, sh: { command: 'x', image: 'evil:1', next: 'done', type: 'shell' } },
      'sh'
    );
    const issues = await checkSpec(fastify, ADMIN, TEAM_ID, bad);
    const [authoring] = issues.filter((i) => i.source === 'authoring');
    expect(authoring).toMatchObject({
      code: 'SHELL_IMAGE_NOT_ALLOWED',
      nodeId: 'sh',
      severity: 'error',
    });
    expect(authoring?.message).toMatch(/^image 'evil:1' is not on the shell-step allowlist/);
  });

  it('reports no authoring issues for an admin using a built-in image', async () => {
    const { fastify } = fastifyWith({ team: null });
    const issues = await checkSpec(fastify, ADMIN, TEAM_ID, SHELL_SPEC);
    expect(issues.filter((i) => i.source === 'authoring')).toEqual([]);
  });
});
