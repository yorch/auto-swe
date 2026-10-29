import { SPEC_SCHEMA_VERSION } from '@auto-swe/shared/workflow';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { workflowTemplateRoutes } from './workflowTemplates.js';

const TEAM_ID = 'a1b2c3d4-1234-4567-89ab-cdef01234567';
const OTHER_TEAM_ID = 'b1b2c3d4-1234-4567-89ab-cdef01234567';
const TEMPLATE_ID = 'c1b2c3d4-1234-4567-89ab-cdef01234567';
const URL = '/api/v1/workflow-templates/validate';

const WRITE_METHODS = new Set([
  'create',
  'createMany',
  'delete',
  'deleteMany',
  'update',
  'updateMany',
  'upsert',
]);

interface Opts {
  role?: string;
  /** The caller's role on TEAM_ID; `null` = not a member. */
  teamRole?: string | null;
  /** Agent keys that exist (active). */
  agents?: string[];
  /** Template row `templateId` resolves to; `null` = not writable by the caller. */
  template?: { teamId: string | null; origin?: string } | null;
  teamAllowlist?: string[];
  /** Names that already exist, as `teamId:name` (`null:` for a global one). */
  taken?: string[];
  /** The newest version number of the template `templateId` resolves to. */
  latestVersion?: number;
}

function buildApp(opts: Opts = {}) {
  const writes: string[] = [];
  const app: FastifyInstance = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: opts.role ?? 'LEAD',
      sub: 'user-1',
    }),
  } as unknown as never);

  const created: unknown[] = [];
  const nameLookups: unknown[] = [];
  const model = (name: string, impl: Record<string, (a: never) => unknown>) =>
    new Proxy(impl, {
      get(target, prop: string) {
        if (WRITE_METHODS.has(prop)) {
          return async (arg: never) => {
            writes.push(`${name}.${prop}`);
            return target[prop] ? target[prop](arg) : arg;
          };
        }
        return target[prop];
      },
    });
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    agent: model('agent', {
      findMany: ((a: { where: { key: { in: string[] } } }) =>
        (opts.agents ?? [])
          .filter((k) => a.where.key.in.includes(k))
          .map((key) => ({ key }))) as never,
    }),
    configAuditLog: model('configAuditLog', {}),
    connection: model('connection', { findMany: (() => []) as never }),
    team: model('team', {
      findUnique: (() => ({
        egressAllowlist: [],
        shellImageAllowlist: opts.teamAllowlist ?? [],
      })) as never,
    }),
    teamMembership: model('teamMembership', {
      findFirst: (() =>
        opts.teamRole === null ? null : { role: opts.teamRole ?? 'LEAD' }) as never,
      findUnique: (() =>
        opts.teamRole === null ? null : { role: opts.teamRole ?? 'LEAD' }) as never,
    }),
    workflowShellAudit: model('workflowShellAudit', {}),
    workflowTemplate: model('workflowTemplate', {
      create: ((a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return {
          ...a.data,
          _count: { versions: 1 },
          id: 'new-id',
          team: null,
          versions: [{ id: 'v1', version: 1 }],
        };
      }) as never,
      findFirst: ((a: { where: { id?: unknown; name?: string; teamId?: string | null } }) => {
        if (a.where.name !== undefined) {
          nameLookups.push(a.where);
          const hit = (opts.taken ?? []).includes(`${a.where.teamId}:${a.where.name}`);
          return hit ? { id: 'other-id' } : null;
        }
        return opts.template === undefined ? null : opts.template;
      }) as never,
    }),
    workflowTemplateVersion: model('workflowTemplateVersion', {
      findFirst: (() =>
        opts.latestVersion === undefined ? null : { version: opts.latestVersion }) as never,
    }),
  };
  app.decorate('prisma', prisma as unknown as never);
  app.register(workflowTemplateRoutes, { prefix: '/api/v1/workflow-templates' });
  return { app, created, nameLookups, writes };
}

const spec = (nodes: Record<string, unknown>, entry = 'start') => ({
  description: '',
  entry,
  name: 'spec',
  nodes,
  schemaVersion: SPEC_SCHEMA_VERSION,
});
const done = { status: 'SUCCESS', type: 'terminate' };
const VALID = spec({ start: done });
const SHELL = spec(
  {
    done,
    sh: { command: 'echo hi', image: 'alpine:latest', next: 'done', type: 'shell' },
  },
  'sh'
);

async function validate(app: FastifyInstance, payload: unknown) {
  return app.inject({
    headers: { authorization: 'Bearer x' },
    method: 'POST',
    payload: payload as object,
    url: URL,
  });
}

type Issue = {
  code: string;
  severity: string;
  message: string;
  nodeId?: string;
  field?: string;
  source: string;
};

describe('POST /workflow-templates/validate', () => {
  it('reports a valid spec as ok with no issues', async () => {
    const { app } = buildApp();
    const res = await validate(app, { spec: VALID, teamId: TEAM_ID });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: { issues: [], ok: true } });
    await app.close();
  });

  it('reports schema failures with the node and field they sit on', async () => {
    const { app } = buildApp();
    const bad = spec(
      {
        a: { agentRef: '', next: 'done', type: 'agent' },
        done,
        t: { status: 'SUCCESS', title: '   ', type: 'terminate' },
      },
      'a'
    );
    const res = await validate(app, { spec: bad });
    const { ok, issues } = res.json().data as { ok: boolean; issues: Issue[] };
    expect(ok).toBe(false);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.source === 'schema' && i.severity === 'error')).toBe(true);
    expect(issues.some((i) => i.code === 'INVALID_PRESENTATION' && i.nodeId === 't')).toBe(true);
    await app.close();
  });

  it('locates an invalid agentRef on its node (schema, no presentation problem)', async () => {
    const { app } = buildApp();
    const bad = spec({ a: { agentRef: '', next: 'done', type: 'agent' }, done }, 'a');
    const { issues } = (await validate(app, { spec: bad })).json().data as { issues: Issue[] };
    expect(issues).toContainEqual(
      expect.objectContaining({ nodeId: 'a', severity: 'error', source: 'schema' })
    );
    await app.close();
  });

  it('rejects a wrong schemaVersion and a non-object spec as schema errors, not 400s', async () => {
    const { app } = buildApp();
    const old = (await validate(app, { spec: { ...VALID, schemaVersion: 0 } })).json().data;
    expect(old.ok).toBe(false);
    expect(old.issues[0]).toMatchObject({ code: 'SCHEMA_VERSION', source: 'schema' });
    const notObject = await validate(app, { spec: 'nope' });
    expect(notObject.statusCode).toBe(200);
    expect(notObject.json().data.issues[0]).toMatchObject({ code: 'SPEC_NOT_OBJECT' });
    const missing = await validate(app, {});
    expect(missing.statusCode).toBe(400); // no `spec` key at all is a malformed envelope
    await app.close();
  });

  // The editor drops a server finding it already shows by matching code/node/field
  // (TemplateEditor issueKey), so these codes and locations are a contract with the web.
  describe('schema contract', () => {
    const noEntry: Record<string, unknown> = { ...VALID };
    delete noEntry.entry;
    const cases: [string, unknown, { code: string; nodeId?: string; field?: string }][] = [
      [
        'internal step',
        spec({ done, s: { next: 'done', step: 'runAgentTask', type: 'step' } }, 's'),
        { code: 'INTERNAL_STEP', field: 'step', nodeId: 's' },
      ],
      ['empty name', { ...VALID, name: '' }, { code: 'SCHEMA_INVALID', field: 'name' }],
      ['missing entry', noEntry, { code: 'SCHEMA_INVALID', field: 'entry' }],
      [
        'empty agentRef',
        spec({ a: { agentRef: '', next: 'done', type: 'agent' }, done }, 'a'),
        { code: 'SCHEMA_INVALID', field: 'agentRef', nodeId: 'a' },
      ],
      [
        'blank title',
        spec({ start: { ...done, title: '  ' } }),
        { code: 'INVALID_PRESENTATION', field: 'title', nodeId: 'start' },
      ],
      [
        'wrong schemaVersion',
        { ...VALID, schemaVersion: 0 },
        { code: 'SCHEMA_VERSION', field: 'schemaVersion' },
      ],
      [
        'bad node type',
        spec({ start: { type: 'nope' } }),
        { code: 'SCHEMA_INVALID', field: 'type', nodeId: 'start' },
      ],
      [
        'empty shell image',
        spec({ done, sh: { command: 'x', image: '', next: 'done', type: 'shell' } }, 'sh'),
        { code: 'SCHEMA_INVALID', field: 'image', nodeId: 'sh' },
      ],
    ];
    it.each(cases)('pins the code and location for: %s', async (_name, input, expected) => {
      const { app } = buildApp({ role: 'ADMIN' });
      const { issues } = (await validate(app, { spec: input })).json().data as { issues: Issue[] };
      const own = issues.filter((i) => i.field === expected.field && i.nodeId === expected.nodeId);
      expect(own).toHaveLength(1);
      expect(own[0]).toMatchObject({ ...expected, severity: 'error', source: 'schema' });
      await app.close();
    });
  });

  it('reports lint errors and warnings from validateSpec', async () => {
    // `a` never reaches a terminate.
    const noTerminal = spec({ a: { agentRef: 'implementer', next: 'a', type: 'agent' } }, 'a');
    const { app } = buildApp({ agents: ['implementer'] });
    const res = await validate(app, { spec: noTerminal });
    const { ok, issues } = res.json().data as { ok: boolean; issues: Issue[] };
    expect(ok).toBe(false);
    const lint = issues.filter((i) => i.source === 'lint');
    expect(lint.some((i) => i.severity === 'error')).toBe(true);
    expect(lint.every((i) => typeof i.code === 'string' && i.message.length > 0)).toBe(true);
    await app.close();
  });

  it('reports a missing agent as a refs warning that leaves ok true', async () => {
    const s = spec({ a: { agentRef: 'ghost@2', next: 'done', type: 'agent' }, done }, 'a');
    const { app } = buildApp({ agents: [] });
    const { ok, issues } = (await validate(app, { spec: s })).json().data as {
      ok: boolean;
      issues: Issue[];
    };
    const ref = issues.find((i) => i.source === 'refs');
    expect(ref).toMatchObject({
      code: 'AGENT_REF_UNRESOLVED',
      field: 'agentRef',
      nodeId: 'a',
      severity: 'warning',
    });
    expect(ok).toBe(issues.every((i) => i.severity !== 'error'));
    await app.close();

    const { app: found } = buildApp({ agents: ['ghost'] });
    const again = (await validate(found, { spec: s })).json().data as { issues: Issue[] };
    expect(again.issues.find((i) => i.source === 'refs')).toBeUndefined();
    await found.close();
  });

  it('answers a missing agent exactly as for an unreadable one (existence only, any scope)', async () => {
    // The refs check is an any-scope existence test: its message names only what the caller
    // typed, so it says nothing about agents or connections the caller cannot see.
    const s = spec({ a: { agentRef: 'secret', next: 'done', type: 'agent' }, done }, 'a');
    const { app } = buildApp({ agents: [] });
    const { issues } = (await validate(app, { spec: s })).json().data as { issues: Issue[] };
    expect(JSON.stringify(issues)).not.toMatch(/team|scope:|owner/i);
    await app.close();
  });

  describe('shell authoring gate', () => {
    it('is an authoring error for a LEAD who is not team admin', async () => {
      const { app } = buildApp({ role: 'LEAD', teamRole: 'LEAD' });
      const res = await validate(app, { spec: SHELL, teamId: TEAM_ID });
      expect(res.statusCode).toBe(200);
      const { ok, issues } = res.json().data as { ok: boolean; issues: Issue[] };
      expect(ok).toBe(false);
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'SHELL_AUTHOR_FORBIDDEN',
          severity: 'error',
          source: 'authoring',
        })
      );
      await app.close();
    });

    it('passes for a team admin and for a platform admin', async () => {
      const teamAdmin = buildApp({ role: 'LEAD', teamRole: 'ADMIN' });
      const a = (await validate(teamAdmin.app, { spec: SHELL, teamId: TEAM_ID })).json().data;
      expect(a.issues.filter((i: Issue) => i.source === 'authoring')).toEqual([]);
      expect(a.ok).toBe(true);
      const admin = buildApp({ role: 'ADMIN' });
      const b = (await validate(admin.app, { spec: SHELL })).json().data;
      expect(b.issues.filter((i: Issue) => i.source === 'authoring')).toEqual([]);
      await teamAdmin.app.close();
      await admin.app.close();
    });

    it('judges a spec with no template or team as a global template', async () => {
      const { app } = buildApp({ role: 'LEAD', teamRole: 'ADMIN' });
      const { issues } = (await validate(app, { spec: SHELL })).json().data as {
        issues: Issue[];
      };
      expect(issues).toContainEqual(
        expect.objectContaining({ code: 'SHELL_AUTHOR_FORBIDDEN', source: 'authoring' })
      );
      await app.close();
    });

    it('refuses a non-admin saving globally, as POST / would, but not an admin or a team save', async () => {
      const lead = buildApp({ role: 'LEAD' });
      const { ok, issues } = (await validate(lead.app, { spec: VALID })).json().data;
      expect(ok).toBe(false);
      expect(issues).toEqual([
        expect.objectContaining({ code: 'FORBIDDEN', severity: 'error', source: 'authoring' }),
      ]);
      const team = (await validate(lead.app, { spec: VALID, teamId: TEAM_ID })).json().data;
      expect(team).toEqual({ issues: [], ok: true });
      const admin = buildApp({ role: 'ADMIN' });
      expect((await validate(admin.app, { spec: VALID })).json().data.ok).toBe(true);
      // On create a spec that does not parse is a 400 before the scope is looked at.
      const bad = (await validate(lead.app, { spec: { ...VALID, name: '' } })).json().data;
      expect(bad.issues.every((i: Issue) => i.source === 'schema')).toBe(true);
      await lead.app.close();
      await admin.app.close();
    });

    it('takes the scope from templateId when given', async () => {
      const { app } = buildApp({
        role: 'LEAD',
        teamRole: 'ADMIN',
        template: { teamId: TEAM_ID },
      });
      const res = await validate(app, { spec: SHELL, templateId: TEMPLATE_ID });
      expect(res.json().data.ok).toBe(true);
      await app.close();
    });

    it('reports an image outside the allowlist, on its node', async () => {
      const s = spec(
        {
          done,
          sh: { command: 'x', image: 'evil/miner:1', next: 'done', type: 'shell' },
        },
        'sh'
      );
      const { app } = buildApp({ role: 'LEAD', teamRole: 'ADMIN' });
      const { ok, issues } = (await validate(app, { spec: s, teamId: TEAM_ID })).json().data as {
        ok: boolean;
        issues: Issue[];
      };
      expect(ok).toBe(false);
      expect(issues).toContainEqual(
        expect.objectContaining({
          code: 'SHELL_IMAGE_NOT_ALLOWED',
          nodeId: 'sh',
          severity: 'error',
          source: 'authoring',
        })
      );
      await app.close();
    });
  });

  describe('access', () => {
    it('refuses an ENGINEER with 403', async () => {
      const { app } = buildApp({ role: 'ENGINEER' });
      const res = await validate(app, { spec: VALID });
      expect(res.statusCode).toBe(403);
      await app.close();
    });

    it('refuses a request with no credentials', async () => {
      const { app } = buildApp();
      const res = await app.inject({ method: 'POST', payload: { spec: VALID }, url: URL });
      expect(res.statusCode).toBe(401);
      await app.close();
    });

    it('404s a templateId the caller cannot write, and a system template', async () => {
      const none = buildApp({ template: null });
      expect((await validate(none.app, { spec: VALID, templateId: TEMPLATE_ID })).statusCode).toBe(
        404
      );
      const system = buildApp({ template: { origin: 'system:agent-run', teamId: null } });
      expect(
        (await validate(system.app, { spec: VALID, templateId: TEMPLATE_ID })).statusCode
      ).toBe(404);
      await none.app.close();
      await system.app.close();
    });

    it('403s a teamId the non-admin caller cannot author for', async () => {
      const { app } = buildApp({ role: 'LEAD', teamRole: null });
      const res = await validate(app, { spec: SHELL, teamId: OTHER_TEAM_ID });
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.json())).not.toMatch(/allowlist|alpine/i);
      await app.close();
    });
  });

  describe('save outcomes (name and base version)', () => {
    const saveIssues = (issues: Issue[]) => issues.filter((i) => i.source === 'save');

    it('leaves a spec-only call exactly as before', async () => {
      const { app, nameLookups } = buildApp({ latestVersion: 9, taken: [`${TEAM_ID}:x`] });
      const res = await validate(app, { spec: VALID, teamId: TEAM_ID });
      expect(res.json()).toEqual({ data: { issues: [], ok: true } });
      expect(nameLookups).toEqual([]);
      await app.close();
    });

    it('reports a reserved name as an error, as the create route does', async () => {
      const { app } = buildApp({ role: 'ADMIN' });
      const { ok, issues } = (await validate(app, { name: ' agent run ', spec: VALID })).json()
        .data as { ok: boolean; issues: Issue[] };
      expect(ok).toBe(false);
      expect(saveIssues(issues)).toEqual([
        expect.objectContaining({
          code: 'RESERVED_TEMPLATE_NAME',
          field: 'name',
          severity: 'error',
        }),
      ]);
      const save = await app.inject({
        headers: { authorization: 'Bearer x' },
        method: 'POST',
        payload: { name: ' agent run ', spec: VALID },
        url: '/api/v1/workflow-templates',
      });
      expect(save.statusCode).toBe(400);
      expect(save.json().error.code).toBe('RESERVED_TEMPLATE_NAME');
      expect(save.json().error.message).toBe(saveIssues(issues)[0]?.message);
      await app.close();
    });

    it('reports a name already used in the team as NAME_CONFLICT, with the save route message', async () => {
      const { app, nameLookups } = buildApp({ taken: [`${TEAM_ID}:Billing`] });
      const { ok, issues } = (
        await validate(app, { name: 'Billing', spec: VALID, teamId: TEAM_ID })
      ).json().data as { ok: boolean; issues: Issue[] };
      expect(ok).toBe(false);
      expect(saveIssues(issues)).toEqual([
        expect.objectContaining({
          code: 'NAME_CONFLICT',
          field: 'name',
          message: 'A template with this name already exists',
          severity: 'error',
        }),
      ]);
      expect(nameLookups).toEqual([{ name: 'Billing', teamId: TEAM_ID }]);
      const free = (await validate(app, { name: 'Other', spec: VALID, teamId: TEAM_ID })).json()
        .data;
      expect(free).toEqual({ issues: [], ok: true });
      await app.close();
    });

    it('does not count the template being renamed as a conflict with itself', async () => {
      const { app, nameLookups } = buildApp({
        taken: [`${TEAM_ID}:Billing`],
        template: { teamId: TEAM_ID },
      });
      await validate(app, { name: 'Billing', spec: VALID, templateId: TEMPLATE_ID });
      expect(nameLookups).toEqual([{ id: { not: TEMPLATE_ID }, name: 'Billing', teamId: TEAM_ID }]);
      await app.close();
    });

    it('warns, without failing the check, when the base version is behind the newest', async () => {
      const { app } = buildApp({ latestVersion: 4, template: { teamId: TEAM_ID } });
      const { ok, issues } = (
        await validate(app, { baseVersion: 2, spec: VALID, templateId: TEMPLATE_ID })
      ).json().data as { ok: boolean; issues: Issue[] };
      expect(ok).toBe(true);
      expect(saveIssues(issues)).toEqual([
        expect.objectContaining({
          code: 'STALE_BASE_VERSION',
          field: 'baseVersion',
          severity: 'warning',
        }),
      ]);
      expect(saveIssues(issues)[0]?.message).toMatch(/version 2.*version 4.*version 5/);
      await app.close();
    });

    it('is silent when the base version is the newest', async () => {
      const { app } = buildApp({ latestVersion: 4, template: { teamId: TEAM_ID } });
      const res = await validate(app, { baseVersion: 4, spec: VALID, templateId: TEMPLATE_ID });
      expect(res.json().data).toEqual({ issues: [], ok: true });
      await app.close();
    });

    it('400s a base version with no template', async () => {
      const { app } = buildApp();
      expect((await validate(app, { baseVersion: 1, spec: VALID })).statusCode).toBe(400);
      expect(
        (await validate(app, { baseVersion: 0, spec: VALID, templateId: TEMPLATE_ID })).statusCode
      ).toBe(400);
      await app.close();
    });

    describe('across tenants', () => {
      it('is not an oracle for a name in a team the caller cannot author for', async () => {
        const { app, nameLookups } = buildApp({
          role: 'LEAD',
          taken: [`${OTHER_TEAM_ID}:Secret`],
          teamRole: null,
        });
        const res = await validate(app, { name: 'Secret', spec: VALID, teamId: OTHER_TEAM_ID });
        expect(res.statusCode).toBe(403);
        expect(JSON.stringify(res.json())).not.toMatch(/NAME_CONFLICT|already exists/);
        expect(nameLookups).toEqual([]);
        await app.close();
      });

      it('never looks up a global name for a non-admin, so a global template cannot be probed', async () => {
        const { app, nameLookups } = buildApp({ role: 'LEAD', taken: ['null:Shared'] });
        const { issues } = (await validate(app, { name: 'Shared', spec: VALID })).json().data as {
          issues: Issue[];
        };
        expect(issues.map((i) => i.code)).toEqual(['FORBIDDEN']);
        expect(nameLookups).toEqual([]);
        await app.close();
      });

      it('does not report a repeated global name, because the save accepts it', async () => {
        const { app, nameLookups } = buildApp({ role: 'ADMIN', taken: ['null:Shared'] });
        const res = await validate(app, { name: 'Shared', spec: VALID });
        expect(res.json().data).toEqual({ issues: [], ok: true });
        expect(nameLookups).toEqual([]);
        await app.close();
      });

      it('looks a name up only in the scope it would be saved into', async () => {
        const { app, nameLookups } = buildApp({
          role: 'LEAD',
          taken: [`${OTHER_TEAM_ID}:Billing`],
        });
        const res = await validate(app, { name: 'Billing', spec: VALID, teamId: TEAM_ID });
        expect(res.json().data).toEqual({ issues: [], ok: true });
        expect(nameLookups).toEqual([{ name: 'Billing', teamId: TEAM_ID }]);
        await app.close();
      });

      it('404s a template the caller cannot write before reading its versions', async () => {
        const { app } = buildApp({ latestVersion: 7, template: null });
        const res = await validate(app, { baseVersion: 1, spec: VALID, templateId: TEMPLATE_ID });
        expect(res.statusCode).toBe(404);
        expect(JSON.stringify(res.json())).not.toMatch(/version 7/);
        await app.close();
      });
    });

    it('writes nothing', async () => {
      const { app, writes } = buildApp({
        latestVersion: 3,
        role: 'ADMIN',
        taken: [`${TEAM_ID}:A`],
        template: { teamId: TEAM_ID },
      });
      await validate(app, { name: 'A', spec: VALID, teamId: TEAM_ID });
      await validate(app, { baseVersion: 1, name: 'A', spec: VALID, templateId: TEMPLATE_ID });
      expect(writes).toEqual([]);
      await app.close();
    });
  });

  describe('request envelope', () => {
    it('400s a malformed envelope', async () => {
      const { app } = buildApp();
      expect((await validate(app, { spec: VALID, templateId: 'not-a-uuid' })).statusCode).toBe(400);
      expect((await validate(app, { spec: VALID, teamId: 5 })).statusCode).toBe(400);
      const notObject = await app.inject({
        headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
        method: 'POST',
        payload: '[1,2]',
        url: URL,
      });
      expect(notObject.statusCode).toBe(400);
      await app.close();
    });

    it('413s a body over the default limit, as the save routes do', async () => {
      const { app } = buildApp();
      const res = await validate(app, { spec: { pad: 'x'.repeat(1_100_000) } });
      expect(res.statusCode).toBe(413);
      await app.close();
    });
  });

  it('writes nothing, whatever the verdict', async () => {
    const cases = [
      VALID,
      SHELL,
      spec({ a: { agentRef: 'ghost', next: 'done', type: 'agent' }, done }, 'a'),
      { nonsense: true },
    ];
    for (const s of cases) {
      const { app, writes, created } = buildApp({ role: 'ADMIN' });
      await validate(app, { spec: s });
      await validate(app, { spec: s, teamId: TEAM_ID });
      expect(writes).toEqual([]);
      expect(created).toEqual([]);
      await app.close();
    }
  });
});

describe('validate / create parity', () => {
  const cases: Array<{ name: string; spec: unknown; role: string; teamRole: string }> = [
    { name: 'valid', role: 'LEAD', spec: VALID, teamRole: 'LEAD' },
    {
      name: 'wrong schemaVersion',
      role: 'LEAD',
      spec: { ...VALID, schemaVersion: 0 },
      teamRole: 'LEAD',
    },
    { name: 'not an object', role: 'LEAD', spec: 'x', teamRole: 'LEAD' },
    {
      name: 'blank title',
      role: 'LEAD',
      spec: spec({ start: { ...done, title: ' ' } }),
      teamRole: 'LEAD',
    },
    {
      name: 'empty agentRef',
      role: 'LEAD',
      spec: spec({ a: { agentRef: '', next: 'done', type: 'agent' }, done }, 'a'),
      teamRole: 'LEAD',
    },
    {
      name: 'unknown agent (warning only)',
      role: 'LEAD',
      spec: spec({ a: { agentRef: 'ghost', next: 'done', type: 'agent' }, done }, 'a'),
      teamRole: 'LEAD',
    },
    {
      name: 'lint error saves with warnings',
      role: 'LEAD',
      spec: spec({ a: { agentRef: 'x', next: 'a', type: 'agent' } }, 'a'),
      teamRole: 'LEAD',
    },
    { name: 'shell, team lead', role: 'LEAD', spec: SHELL, teamRole: 'LEAD' },
    { name: 'shell, team admin', role: 'LEAD', spec: SHELL, teamRole: 'ADMIN' },
    { name: 'shell, platform admin', role: 'ADMIN', spec: SHELL, teamRole: 'LEAD' },
    {
      name: 'shell, image not allowed',
      role: 'ADMIN',
      spec: spec(
        {
          done,
          sh: { command: 'x', image: 'evil/miner:1', next: 'done', type: 'shell' },
        },
        'sh'
      ),
      teamRole: 'ADMIN',
    },
  ];

  for (const c of cases) {
    it(`agrees with POST / on: ${c.name}`, async () => {
      const opts = { role: c.role, teamRole: c.teamRole };
      const v = buildApp(opts);
      const verdict = await validate(v.app, { spec: c.spec, teamId: TEAM_ID });
      const { issues } = verdict.json().data as { issues: Issue[] };
      // What a save refuses: the schema parse (400) and the authoring gates (403 / 400).
      const refusing = issues.filter((i) => i.severity === 'error' && i.source !== 'lint');

      const s = buildApp(opts);
      const save = await s.app.inject({
        headers: { authorization: 'Bearer x' },
        method: 'POST',
        payload: { name: 'parity', spec: c.spec, teamId: TEAM_ID } as object,
        url: '/api/v1/workflow-templates',
      });

      if (refusing.length > 0) {
        expect([400, 403]).toContain(save.statusCode);
        expect(s.created).toEqual([]);
        if (save.statusCode === 400 && refusing[0]?.source === 'authoring') {
          expect(save.json().error.code).toBe(refusing[0].code);
        }
        if (save.statusCode === 403) {
          expect(save.json().error.code).toBe(refusing[0]?.code);
        }
      } else {
        expect(save.statusCode).toBe(201);
        // Everything the save only warns about is what validate reports as lint/refs.
        const warnings = (save.json().warnings ?? []) as string[];
        expect(warnings.length).toBe(
          issues.filter((i) => i.source === 'lint' || i.source === 'refs').length
        );
      }
      await v.app.close();
      await s.app.close();
    });
  }
});
