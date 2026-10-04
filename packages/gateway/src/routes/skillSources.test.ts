import { SkillSourceError } from '@auto-swe/shared/lib/skillSource';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const { fetchSkillSource, scanSkillContent, resolveSetting } = vi.hoisted(() => ({
  fetchSkillSource: vi.fn(),
  resolveSetting: vi.fn(async () => true),
  scanSkillContent: vi.fn(async (_text: string, _opts?: { full?: boolean }) => ({
    incomplete: false,
    safe: true,
    warnings: [] as string[],
  })),
}));
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({ scanSkillContent }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting }));
vi.mock('@auto-swe/shared/lib/skillSource', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@auto-swe/shared/lib/skillSource')>()),
  fetchSkillSource,
}));

import { skillSourceRoutes } from './skillSources.js';

const TEAM_ID = '00000000-0000-4000-a000-0000000000a1';
const ORG_ID = '00000000-0000-4000-a000-0000000000b1';
const SOURCE_ID = '00000000-0000-4000-a000-0000000000c1';

type Row = Record<string, unknown> & { id: string };

function sourceSkill(name: string, over: Record<string, unknown> = {}) {
  return {
    description: `${name} description`,
    errors: [] as string[],
    folder: `skills/${name}`,
    ignoredKeys: [] as string[],
    name,
    promptText: `Prompt for ${name}`,
    referenceFiles: [{ content: 'ref text', path: 'notes.md' }],
    skippedFiles: [{ path: 'run.sh', reason: 'not-text' }],
    ...over,
  };
}

const revisionOf = (skill: Row | undefined) =>
  ((skill as Row).revisionRows as { create: Record<string, unknown> }).create;

const fetched = (skills = [sourceSkill('alpha'), sourceSkill('beta')]) => ({ sha: SHA, skills });

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const state = {
    audit: [] as Row[],
    skills: [] as Row[],
    sources: [] as Row[],
  };
  let seq = 0;
  const id = (p: string) =>
    `00000000-0000-4000-a000-${p}${String(++seq).padStart(11 - p.length + 1, '0')}`.slice(0, 36);
  const whereMatches = (row: Row, where: Record<string, unknown> | undefined): boolean => {
    if (!where) {
      return true;
    }
    if (Array.isArray(where.OR)) {
      return (where.OR as Array<Record<string, unknown>>).some((w) => whereMatches(row, w));
    }
    return Object.entries(where).every(([k, v]) =>
      v && typeof v === 'object' && row[k] && typeof row[k] === 'object'
        ? whereMatches(row[k] as Row, v as Record<string, unknown>)
        : row[k] === v
    );
  };

  const model = (rows: Row[], extra: (r: Row) => Row = (r) => r) => ({
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      rows.filter((r) => whereMatches(r, where)).map((r) => extra({ ...r }))
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const r = rows.find((x) => x.id === where.id);
      return r ? extra({ ...r }) : null;
    }),
  });

  const skillModel = {
    ...model(state.skills),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      if (data.name === 'boom') {
        throw new Error('database exploded');
      }
      order.push(`skill.create:${String(data.name)}`);
      const { revisions, ...rest } = data as { revisions?: unknown } & Record<string, unknown>;
      const row = { id: id('5'), ...rest, revisionRows: revisions } as Row;
      state.skills.push(row);
      return { ...row };
    }),
  };
  const sourceModel = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const dup = state.sources.some(
        (s) =>
          s.host === data.host &&
          s.owner === data.owner &&
          s.repo === data.repo &&
          s.path === data.path &&
          s.scope === data.scope
      );
      if (dup) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const row = { id: id('6'), status: 'OK', ...data } as Row;
      state.sources.push(row);
      return { ...row };
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      const i = state.sources.findIndex((s) => s.id === where.id);
      state.sources.splice(i, 1);
      // The FK: skills of a deleted source are detached, not deleted.
      for (const sk of state.skills) {
        if (sk.sourceId === where.id) {
          sk.sourceId = null;
        }
      }
    }),
    findMany: vi.fn(async () =>
      state.sources.map((s) => ({
        ...s,
        _count: { skills: state.skills.filter((k) => k.sourceId === s.id).length },
      }))
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const s = state.sources.find((x) => x.id === where.id);
      return s
        ? { ...s, skills: state.skills.filter((k) => k.sourceId === s.id).map((k) => ({ ...k })) }
        : null;
    }),
    update: vi.fn(
      async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const s = state.sources.find((x) => x.id === where.id) as Row;
        for (const [k, v] of Object.entries(data)) {
          if (v !== undefined) {
            s[k] = v;
          }
        }
        return { ...s };
      }
    ),
  };
  const order: string[] = [];
  const prisma = {
    $executeRaw: vi.fn(async () => {
      order.push('lock');
      return 0;
    }),
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const snapshot = {
        audit: [...state.audit],
        skills: state.skills.map((s) => ({ ...s })),
        sources: state.sources.map((s) => ({ ...s })),
      };
      try {
        return await cb(prisma);
      } catch (err) {
        state.audit.splice(0, state.audit.length, ...snapshot.audit);
        state.skills.splice(0, state.skills.length, ...snapshot.skills);
        state.sources.splice(0, state.sources.length, ...snapshot.sources);
        throw err;
      }
    }),
    configAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.audit.push({ id: id('7'), ...data });
        return {};
      }),
    },
    organization: { findUnique: vi.fn(async () => ({ id: 'org' })) },
    skill: skillModel,
    skillSource: sourceModel,
    team: { findUnique: vi.fn(async () => ({ id: TEAM_ID, orgId: ORG_ID })) },
  };

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('prisma', prisma as unknown as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({ exp: 9999999999, iat: 0, role, sub: 'user-1' }),
  } as unknown as never);
  await app.register(skillSourceRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer token' },
      method,
      payload: payload as never,
      url: `/api/v1/platform/skill-sources${url}`,
    });
  return { call, order, prisma, state };
}

const SOURCE = { owner: 'Acme', path: 'skills', ref: 'main', repo: 'Skills' };

beforeEach(() => {
  vi.clearAllMocks();
  fetchSkillSource.mockResolvedValue(fetched());
  resolveSetting.mockResolvedValue(true);
  scanSkillContent.mockResolvedValue({ incomplete: false, safe: true, warnings: [] });
});

describe('access', () => {
  it.each([
    ['POST', '/preview'],
    ['POST', ''],
    ['GET', ''],
    ['GET', `/${SOURCE_ID}`],
    ['PATCH', `/${SOURCE_ID}`],
    ['DELETE', `/${SOURCE_ID}`],
  ] as const)('%s %s is ADMIN-only', async (method, url) => {
    const { call, prisma, state } = await buildApp('ENGINEER');
    const res = await call(method, url, { ...SOURCE, sha: SHA, skills: ['alpha'], status: 'OK' });
    expect(res.statusCode).toBe(403);
    expect(fetchSkillSource).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.sources).toHaveLength(0);
  });
});

describe('POST /preview with skill (full text)', () => {
  it('returns the complete text of that skill at the resolved sha, writing and scanning nothing', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([sourceSkill('alpha', { promptText: 'ALPHA \u202e FULL' }), sourceSkill('beta')])
    );
    const { call, prisma, state } = await buildApp();
    const res = await call('POST', '/preview', { ...SOURCE, skill: 'alpha' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      folder: 'skills/alpha',
      name: 'alpha',
      promptText: 'ALPHA \u202e FULL',
      referenceFiles: [{ length: 8, path: 'notes.md' }],
      sha: SHA,
    });
    expect(fetchSkillSource).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme' }),
      { scriptMode: 'TEXT_ONLY' },
      undefined
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.sources).toHaveLength(0);
    expect(scanSkillContent).not.toHaveBeenCalled();
  });

  it('400s a skill the source does not hold, and maps a fetch failure to its fixed string', async () => {
    const { call } = await buildApp();
    const unknown = await call('POST', '/preview', { ...SOURCE, skill: 'nope' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatchObject({
      code: 'SKILL_IMPORT_UNKNOWN_SKILLS',
      details: ['nope'],
    });
    fetchSkillSource.mockRejectedValueOnce(new SkillSourceError('NOT_FOUND'));
    const failed = await call('POST', '/preview', { ...SOURCE, skill: 'alpha' });
    expect(failed.statusCode).toBe(404);
    expect(failed.json().error.code).toBe('SKILL_SOURCE_NOT_FOUND');
  });

  it('with a sha, reads the source expecting that commit; a moved ref is 409 SHA_MOVED', async () => {
    const { call } = await buildApp();
    const ok = await call('POST', '/preview', { ...SOURCE, sha: SHA, skill: 'alpha' });
    expect(ok.statusCode).toBe(200);
    expect(fetchSkillSource).toHaveBeenCalledWith(
      expect.anything(),
      { expectSha: SHA, scriptMode: 'TEXT_ONLY' },
      undefined
    );
    fetchSkillSource.mockRejectedValueOnce(new SkillSourceError('SHA_MOVED'));
    const moved = await call('POST', '/preview', { ...SOURCE, sha: OTHER_SHA, skill: 'alpha' });
    expect(moved.statusCode).toBe(409);
    expect(moved.json().error.code).toBe('SKILL_SOURCE_SHA_MOVED');
    expect(
      (await call('POST', '/preview', { ...SOURCE, sha: 'nothex', skill: 'alpha' })).statusCode
    ).toBe(400);
  });

  it('is ADMIN-only', async () => {
    const { call } = await buildApp('ENGINEER');
    expect((await call('POST', '/preview', { ...SOURCE, skill: 'alpha' })).statusCode).toBe(403);
    expect(fetchSkillSource).not.toHaveBeenCalled();
  });
});

describe('POST /preview', () => {
  it('reports each skill and writes nothing', async () => {
    scanSkillContent.mockResolvedValueOnce({
      incomplete: false,
      safe: false,
      warnings: ['injection:x'],
    });
    fetchSkillSource.mockResolvedValue(
      fetched([
        sourceSkill('alpha'),
        sourceSkill('beta'),
        sourceSkill('bad', { errors: ['SKILL.md has no YAML frontmatter'], name: null }),
      ])
    );
    const { call, prisma, state } = await buildApp();
    const res = await call('POST', '/preview', { ...SOURCE, scriptMode: 'REJECT' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.sha).toBe(SHA);
    expect(data.location).toMatchObject({ host: 'github.com', owner: 'acme', repo: 'skills' });
    expect(fetchSkillSource).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme' }),
      { scriptMode: 'REJECT' },
      undefined
    );
    const [alpha, beta, bad] = data.skills;
    expect(alpha).toMatchObject({
      blockedByScan: true,
      installable: false,
      name: 'alpha',
      referenceFileCount: 1,
      scanWarnings: ['injection:x'],
      skippedFiles: [{ path: 'run.sh', reason: 'not-text' }],
      textLength: 'Prompt for alpha'.length,
    });
    expect(beta).toMatchObject({ blockedByScan: false, installable: true, scanWarnings: [] });
    expect(bad).toMatchObject({ errors: ['SKILL.md has no YAML frontmatter'], installable: false });
    // Nothing written: no transaction, no create, no audit.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.skill.create).not.toHaveBeenCalled();
    expect(prisma.skillSource.create).not.toHaveBeenCalled();
    expect(state.audit).toHaveLength(0);
  });

  it('shows repository-derived text without control characters, and the ignored keys', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([
        sourceSkill('alpha', {
          folder: 'bad\u001b[2Kdir',
          ignoredKeys: ['allowed-tools'],
          skippedFiles: [{ path: 'x', reason: 'not-text' }],
        }),
      ])
    );
    const { call } = await buildApp();
    const { data } = (await call('POST', '/preview', SOURCE)).json();
    expect(data.skills[0].folder).toBe('bad?[2Kdir');
    expect(data.skills[0].ignoredKeys).toEqual(['allowed-tools']);
  });

  it('scans the description with the text in full', async () => {
    const { call } = await buildApp();
    await call('POST', '/preview', SOURCE);
    expect(scanSkillContent).toHaveBeenCalledWith('alpha description\nPrompt for alpha', {
      full: true,
    });
  });

  it('marks a name conflict (case-insensitive) with the existing skill', async () => {
    const { call, state } = await buildApp();
    state.skills.push({ id: 'existing-1', name: 'ALPHA', scope: 'GLOBAL' });
    const { data } = (await call('POST', '/preview', SOURCE)).json();
    expect(data.skills[0]).toMatchObject({
      conflicts: [{ id: 'existing-1', name: 'ALPHA', scope: 'GLOBAL' }],
      installable: false,
    });
    expect(data.skills[1].conflicts).toEqual([]);
  });

  it('does not block on warnings when the setting is off', async () => {
    resolveSetting.mockResolvedValue(false);
    scanSkillContent.mockResolvedValueOnce({
      incomplete: false,
      safe: false,
      warnings: ['injection:x'],
    });
    const { call } = await buildApp();
    const { data } = (await call('POST', '/preview', SOURCE)).json();
    expect(data.skills[0]).toMatchObject({ blockedByScan: false, installable: true });
    expect(data.skills[0].scanWarnings).toEqual(['injection:x']);
  });

  it('treats an incomplete scan as a warning', async () => {
    scanSkillContent.mockResolvedValueOnce({ incomplete: true, safe: true, warnings: [] });
    const { call } = await buildApp();
    const { data } = (await call('POST', '/preview', SOURCE)).json();
    expect(data.skills[0].scanWarnings).toEqual([expect.stringContaining('scan-incomplete')]);
    expect(data.skills[0].blockedByScan).toBe(true);
  });

  it.each([
    ['HOST_NOT_APPROVED', 400],
    ['NOT_FOUND', 404],
    ['TREE_TRUNCATED', 422],
    ['UNAUTHORIZED', 502],
    ['TIMEOUT', 504],
    ['LIMIT_REQUESTS', 422],
    ['RATE_LIMIT_LOW', 503],
  ] as const)('maps a %s failure to %i with a fixed message', async (code, status) => {
    fetchSkillSource.mockRejectedValue(new SkillSourceError(code, 'ghp_SECRET bob:hunter2@x'));
    const { call } = await buildApp();
    const res = await call('POST', '/preview', SOURCE);
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(`SKILL_SOURCE_${code}`);
    expect(res.body).not.toContain('ghp_SECRET');
    expect(res.body).not.toContain('hunter2');
  });

  it('rejects a GLOBAL source that names a team, and a TEAM source without one', async () => {
    const { call } = await buildApp();
    expect((await call('POST', '/preview', { ...SOURCE, teamId: TEAM_ID })).statusCode).toBe(400);
    expect((await call('POST', '/preview', { ...SOURCE, scope: 'TEAM' })).statusCode).toBe(400);
  });
});

describe('POST /skill-sources', () => {
  const create = (
    call: Awaited<ReturnType<typeof buildApp>>['call'],
    over: Record<string, unknown> = {}
  ) => call('POST', '', { ...SOURCE, sha: SHA, skills: ['alpha', 'beta'], ...over });

  it('creates the source and each skill at revision 1, unverified, with provenance, and audits', async () => {
    scanSkillContent.mockResolvedValue({ incomplete: false, safe: true, warnings: [] });
    resolveSetting.mockResolvedValue(false);
    const { call, prisma, state } = await buildApp();
    const res = await create(call);
    expect(res.statusCode).toBe(201);
    expect(fetchSkillSource).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'skills' }),
      { expectSha: SHA, scriptMode: 'TEXT_ONLY' },
      undefined
    );
    expect(state.sources).toEqual([
      expect.objectContaining({
        createdById: 'user-1',
        host: 'github.com',
        owner: 'acme',
        path: 'skills',
        pinnedSha: SHA,
        ref: 'main',
        repo: 'skills',
        scope: 'GLOBAL',
        scriptMode: 'TEXT_ONLY',
      }),
    ]);
    const source = state.sources[0] as Row;
    expect(state.skills).toHaveLength(2);
    expect(state.skills[0]).toMatchObject({
      currentRevision: 1,
      description: 'alpha description',
      isBuiltIn: false,
      isVerified: false,
      name: 'alpha',
      promptText: 'Prompt for alpha',
      scope: 'GLOBAL',
      sourceId: source.id,
      sourcePath: 'skills/alpha',
    });
    const revision = revisionOf(state.skills[0]);
    expect(revision).toMatchObject({
      createdBy: { connect: { id: 'user-1' } },
      referenceFiles: [{ content: 'ref text', path: 'notes.md' }],
      revision: 1,
      sourcePath: 'skills/alpha',
      sourceSha: SHA,
    });
    expect(state.audit).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        actorId: 'user-1',
        entityId: source.id,
        entityType: 'SkillSource',
      }),
    ]);
    expect(((state.audit[0] as Row).afterJson as { skills: string[] }).skills).toEqual([
      'alpha',
      'beta',
    ]);
    // The audit entry records what was stored (normalised), not the request spelling.
    expect(state.audit[0]?.afterJson).toMatchObject({ owner: 'acme', repo: 'skills' });
    // One transaction held the lot.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(res.json().data.skills.map((s: { name: string }) => s.name)).toEqual(['alpha', 'beta']);
  });

  it('installs only the chosen skills, never text from the request', async () => {
    const { call, state } = await buildApp();
    const res = await create(call, { promptText: 'evil', skills: ['beta'] });
    expect(res.statusCode).toBe(201);
    expect(state.skills.map((s) => s.name)).toEqual(['beta']);
    expect(state.skills[0]?.promptText).toBe('Prompt for beta');
  });

  it('answers 409 when the ref moved since the preview, writing nothing', async () => {
    fetchSkillSource.mockRejectedValue(new SkillSourceError('SHA_MOVED'));
    const { call, prisma, state } = await buildApp();
    const res = await create(call, { sha: OTHER_SHA });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SKILL_SOURCE_SHA_MOVED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.sources).toHaveLength(0);
  });

  it('lists every name conflict in a 409 and imports nothing', async () => {
    const { call, state } = await buildApp();
    state.skills.push(
      { id: 'e1', name: 'alpha', scope: 'GLOBAL' },
      { id: 'e2', name: 'Beta', scope: 'GLOBAL' }
    );
    const res = await create(call);
    expect(res.statusCode).toBe(409);
    const { error } = res.json();
    expect(error.code).toBe('SKILL_IMPORT_NAME_CONFLICT');
    expect(error.details).toEqual([
      { existingId: 'e1', name: 'alpha', scope: 'GLOBAL' },
      { existingId: 'e2', name: 'Beta', scope: 'GLOBAL' },
    ]);
    expect(state.sources).toHaveLength(0);
    expect(state.skills).toHaveLength(2);
    expect(state.audit).toHaveLength(0);
  });

  it('refuses a skill with warnings while blockOnScanWarnings is on, naming it and why', async () => {
    scanSkillContent.mockImplementation(async (text: string) =>
      text.includes('beta')
        ? { incomplete: false, safe: false, warnings: ['injection:override'] }
        : { incomplete: false, safe: true, warnings: [] }
    );
    const { call, state } = await buildApp();
    const res = await create(call);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'SKILL_IMPORT_SCAN_WARNINGS',
      details: [{ name: 'beta', warnings: ['injection:override'] }],
    });
    expect(state.sources).toHaveLength(0);
  });

  it('refuses an incomplete scan the same way', async () => {
    scanSkillContent.mockResolvedValue({ incomplete: true, safe: true, warnings: [] });
    const { call } = await buildApp();
    const res = await create(call);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SKILL_IMPORT_SCAN_WARNINGS');
  });

  it('installs a flagged skill when the setting is off, recording the warnings on revision 1', async () => {
    resolveSetting.mockResolvedValue(false);
    scanSkillContent.mockResolvedValue({
      incomplete: false,
      safe: false,
      warnings: ['injection:x'],
    });
    const { call, state } = await buildApp();
    const res = await create(call, { skills: ['alpha'] });
    expect(res.statusCode).toBe(201);
    const revision = revisionOf(state.skills[0]);
    expect(revision.scanWarnings).toEqual(['injection:x']);
    expect(state.skills[0]?.isVerified).toBe(false);
  });

  it('refuses a chosen skill that has errors', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([
        sourceSkill('alpha', {
          errors: ['rejected: the folder holds files other than .md/.txt (run.sh)'],
        }),
      ])
    );
    const { call, state } = await buildApp();
    const res = await create(call, { skills: ['alpha'] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('SKILL_IMPORT_NOT_INSTALLABLE');
    expect(state.sources).toHaveLength(0);
  });

  it('refuses a skill name that is not in the source', async () => {
    const { call } = await buildApp();
    const res = await create(call, { skills: ['alpha', 'ghost'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'SKILL_IMPORT_UNKNOWN_SKILLS',
      details: ['ghost'],
    });
  });

  it('is atomic: a failure on the second skill leaves no source, no skill and no audit entry', async () => {
    fetchSkillSource.mockResolvedValue(fetched([sourceSkill('alpha'), sourceSkill('boom')]));
    const { call, state } = await buildApp();
    const res = await create(call, { skills: ['alpha', 'boom'] });
    expect(res.statusCode).toBe(500);
    expect(state.sources).toHaveLength(0);
    expect(state.skills).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });

  it('answers 409 for a source already present in the scope', async () => {
    const { call, state } = await buildApp();
    expect((await create(call, { skills: ['alpha'] })).statusCode).toBe(201);
    // Other skills from the same place: no name clash, but the place is taken.
    const again = await create(call, { skills: ['beta'] });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('SKILL_SOURCE_EXISTS');
    expect(state.sources).toHaveLength(1);
  });

  it('creates a TEAM-scoped source and skills owned by that team', async () => {
    const { call, state } = await buildApp();
    const res = await create(call, { scope: 'TEAM', skills: ['alpha'], teamId: TEAM_ID });
    expect(res.statusCode).toBe(201);
    expect(state.sources[0]).toMatchObject({ orgId: null, scope: 'TEAM', teamId: TEAM_ID });
    expect(state.skills[0]).toMatchObject({ orgId: null, scope: 'TEAM', teamId: TEAM_ID });
  });

  it('a GLOBAL import conflicts with a same-named skill at any scope', async () => {
    const { call, state } = await buildApp();
    state.skills.push({ id: 'e1', name: 'alpha', scope: 'TEAM', teamId: 'some-team' });
    const res = await create(call, { skills: ['alpha'] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual([{ existingId: 'e1', name: 'alpha', scope: 'TEAM' }]);
  });

  it('a TEAM import conflicts with GLOBAL, its organization and its own team', async () => {
    for (const existing of [
      { scope: 'GLOBAL' },
      { orgId: ORG_ID, scope: 'ORGANIZATION' },
      { scope: 'TEAM', teamId: TEAM_ID },
    ]) {
      const { call, state } = await buildApp();
      state.skills.push({ id: 'e1', name: 'alpha', ...existing });
      const res = await create(call, { scope: 'TEAM', skills: ['alpha'], teamId: TEAM_ID });
      expect(res.statusCode, JSON.stringify(existing)).toBe(409);
    }
  });

  it('an ORGANIZATION import conflicts with GLOBAL, the organization and every team in it', async () => {
    const mine = '00000000-0000-4000-a000-0000000000b1';
    for (const existing of [
      { scope: 'GLOBAL' },
      { orgId: mine, scope: 'ORGANIZATION' },
      { scope: 'TEAM', team: { orgId: mine }, teamId: 'a-team-in-the-org' },
    ]) {
      const { call, state } = await buildApp();
      state.skills.push({ id: 'e1', name: 'alpha', ...existing });
      const res = await create(call, { orgId: mine, scope: 'ORGANIZATION', skills: ['alpha'] });
      expect(res.statusCode, JSON.stringify(existing)).toBe(409);
    }
    // A team in another organization is none of its business.
    const { call, state } = await buildApp();
    state.skills.push({ id: 'e2', name: 'alpha', scope: 'TEAM', team: { orgId: 'other-org' } });
    expect(
      (await create(call, { orgId: mine, scope: 'ORGANIZATION', skills: ['alpha'] })).statusCode
    ).toBe(201);
  });

  it('compares names case-insensitively with trailing punctuation and spacing folded away', async () => {
    for (const existing of ['ALPHA', 'alpha.', 'alpha -', ' alpha  ', 'Alpha!!']) {
      const { call, state } = await buildApp();
      state.skills.push({ id: 'e1', name: existing, scope: 'GLOBAL' });
      const res = await create(call, { skills: ['alpha'] });
      expect(res.statusCode, existing).toBe(409);
    }
    const { call, state } = await buildApp();
    state.skills.push({ id: 'e1', name: 'alphabet', scope: 'GLOBAL' });
    expect((await create(call, { skills: ['alpha'] })).statusCode).toBe(201);
  });

  it('refuses two chosen skills whose names fold to one', async () => {
    fetchSkillSource.mockResolvedValue(fetched([sourceSkill('beta'), sourceSkill('Beta.')]));
    const { call, state } = await buildApp();
    const res = await create(call, { skills: ['beta', 'Beta.'] });
    expect(res.statusCode).toBe(409);
    expect(state.sources).toHaveLength(0);
  });

  it('takes the skill-name lock inside the transaction before any skill is written', async () => {
    const { call, order, prisma } = await buildApp();
    await create(call);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['lock', 'skill.create:alpha', 'skill.create:beta']);
  });

  it('does not conflict with another team’s skill of the same name', async () => {
    const { call, state } = await buildApp();
    state.skills.push({ id: 'e1', name: 'alpha', scope: 'TEAM', teamId: 'other-team' });
    const res = await create(call, { scope: 'TEAM', skills: ['alpha'], teamId: TEAM_ID });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a team that does not exist', async () => {
    const { call, prisma } = await buildApp();
    prisma.team.findUnique.mockResolvedValue(null as never);
    const res = await create(call, { scope: 'TEAM', skills: ['alpha'], teamId: TEAM_ID });
    expect(res.statusCode).toBe(400);
    expect(fetchSkillSource).not.toHaveBeenCalled();
  });
});

describe('list, read, patch, delete', () => {
  async function withSource() {
    const app = await buildApp();
    await app.call('POST', '', { ...SOURCE, sha: SHA, skills: ['alpha', 'beta'] });
    return { ...app, id: (app.state.sources[0] as Row).id };
  }

  it('lists sources with their skill count', async () => {
    const { call } = await withSource();
    const res = await call('GET', '');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      expect.objectContaining({ owner: 'acme', pinnedSha: SHA, skillCount: 2 }),
    ]);
  });

  it('returns one source with its skills, and 404 for a missing one', async () => {
    const { call, id } = await withSource();
    const res = await call('GET', `/${id}`);
    expect(res.json().data.skills.map((s: { name: string }) => s.name)).toEqual(['alpha', 'beta']);
    expect((await call('GET', `/${SOURCE_ID}`)).statusCode).toBe(404);
  });

  it('changes scriptMode only, audited, without touching installed skills', async () => {
    const { call, id, state } = await withSource();
    state.audit.length = 0;
    const before = state.skills.map((s) => ({ ...s }));
    const res = await call('PATCH', `/${id}`, { scriptMode: 'REJECT' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.scriptMode).toBe('REJECT');
    expect(state.skills).toEqual(before);
    expect(state.audit).toEqual([
      expect.objectContaining({
        action: 'UPDATE',
        afterJson: { scriptMode: 'REJECT', status: 'OK' },
        beforeJson: { scriptMode: 'TEXT_ONLY', status: 'OK' },
        entityType: 'SkillSource',
      }),
    ]);
  });

  it('disables a source and re-enables it, back to UPDATE_AVAILABLE when a newer commit is known', async () => {
    const { call, id, state } = await withSource();
    expect((await call('PATCH', `/${id}`, { status: 'DISABLED' })).json().data.status).toBe(
      'DISABLED'
    );
    (state.sources[0] as Row).latestSha = OTHER_SHA;
    expect((await call('PATCH', `/${id}`, { status: 'OK' })).json().data.status).toBe(
      'UPDATE_AVAILABLE'
    );
  });

  it('refuses an empty patch and an unknown status', async () => {
    const { call, id } = await withSource();
    expect((await call('PATCH', `/${id}`, {})).statusCode).toBe(400);
    expect((await call('PATCH', `/${id}`, { status: 'ERROR' })).statusCode).toBe(400);
  });

  it('delete detaches the skills (they stay) and is audited', async () => {
    const { call, id, state } = await withSource();
    state.audit.length = 0;
    const res = await call('DELETE', `/${id}`);
    expect(res.statusCode).toBe(204);
    expect(state.sources).toHaveLength(0);
    expect(state.skills.map((s) => [s.name, s.sourceId])).toEqual([
      ['alpha', null],
      ['beta', null],
    ]);
    expect(state.audit).toEqual([
      expect.objectContaining({
        action: 'DELETE',
        entityId: id,
        entityType: 'SkillSource',
      }),
    ]);
    expect(
      ((state.audit[0] as Row).beforeJson as { detachedSkills: string[] }).detachedSkills
    ).toEqual(['alpha', 'beta']);
  });

  it('404s patch and delete of a missing source', async () => {
    const { call } = await buildApp();
    expect((await call('PATCH', `/${SOURCE_ID}`, { scriptMode: 'REJECT' })).statusCode).toBe(404);
    expect((await call('DELETE', `/${SOURCE_ID}`)).statusCode).toBe(404);
  });
});
