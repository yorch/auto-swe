import { skillContentHash } from '@auto-swe/shared/lib/skillRevision';
import { SkillSourceError } from '@auto-swe/shared/lib/skillSource';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);

const { fetchSkillSource, resolveSourceSha, scanSkillContent, resolveSetting } = vi.hoisted(() => ({
  fetchSkillSource: vi.fn(),
  resolveSetting: vi.fn(async () => true),
  resolveSourceSha: vi.fn(),
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
  resolveSourceSha,
}));

import { skillSourceRoutes } from './skillSources.js';

const SOURCE_ID = '00000000-0000-4000-a000-0000000000c1';

type Row = Record<string, unknown> & { id: string };
interface Rev {
  revision: number;
  promptText: string;
  description: string | null;
  contentHash: string;
  sourceSha: string | null;
  sourcePath: string | null;
  referenceFiles: unknown;
  createdById?: string | null;
}

const REF = [{ content: 'ref text', path: 'notes.md' }];

function upstream(name: string, over: Record<string, unknown> = {}) {
  return {
    description: `${name} description`,
    errors: [] as string[],
    folder: `skills/${name}`,
    ignoredKeys: [] as string[],
    name,
    promptText: `Prompt for ${name}`,
    referenceFiles: REF,
    skippedFiles: [] as Array<{ path: string; reason: string }>,
    ...over,
  };
}

/** An installed skill whose revision 1 is the pristine import of `Prompt for <name>` at OLD. */
function installedSkill(name: string, over: Record<string, unknown> = {}): Row {
  const content = { description: `${name} description`, promptText: `Prompt for ${name}` };
  return {
    currentRevision: 1,
    ...content,
    id: `skill-${name}`,
    isVerified: true,
    name,
    revisions: [
      {
        contentHash: skillContentHash(content),
        createdById: null,
        referenceFiles: REF,
        revision: 1,
        sourcePath: `skills/${name}`,
        sourceSha: OLD,
        ...content,
      } satisfies Rev,
    ],
    sourceId: SOURCE_ID,
    sourcePath: `skills/${name}`,
    ...over,
  };
}

const fetched = (skills: unknown[], sha = NEW) => ({ sha, skills });

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const state = {
    audit: [] as Row[],
    skills: [installedSkill('alpha'), installedSkill('beta')] as Row[],
    source: {
      createdAt: new Date(),
      host: 'github.com',
      id: SOURCE_ID,
      lastCheckedAt: null,
      lastError: null,
      latestSha: NEW,
      orgId: null,
      owner: 'acme',
      path: 'skills',
      pinnedSha: OLD,
      ref: 'main',
      repo: 'skills',
      scope: 'GLOBAL',
      scriptMode: 'TEXT_ONLY',
      status: 'UPDATE_AVAILABLE',
      teamId: null,
      updatedAt: new Date(),
    } as Row,
  };
  const writes: string[] = [];
  const clone = (r: Row) => structuredClone(r);
  const p2025 = () => Object.assign(new Error('not found'), { code: 'P2025' });

  const prisma = {
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const snapshot = structuredClone({
        audit: state.audit,
        skills: state.skills,
        source: state.source,
      });
      try {
        return await cb(prisma);
      } catch (err) {
        state.audit.splice(0, state.audit.length, ...snapshot.audit);
        state.skills.splice(0, state.skills.length, ...snapshot.skills);
        state.source = snapshot.source;
        throw err;
      }
    }),
    configAuditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        writes.push('audit');
        state.audit.push({ id: `audit-${state.audit.length}`, ...data });
        return {};
      }),
    },
    skill: {
      findMany: vi.fn(async ({ where }: { where: { sourceId: string } }) =>
        state.skills.filter((s) => s.sourceId === where.sourceId).map(clone)
      ),
      update: vi.fn(
        async ({
          data,
          where,
        }: {
          data: Record<string, unknown> & { revisions?: { create: Rev } };
          where: { id: string; currentRevision: number };
        }) => {
          writes.push('skill.update');
          const row = state.skills.find(
            (s) => s.id === where.id && s.currentRevision === where.currentRevision
          );
          if (!row) {
            throw p2025();
          }
          const { revisions, ...rest } = data;
          Object.assign(row, rest);
          const created = (revisions?.create ?? {}) as unknown as Rev & {
            createdBy?: { connect: { id: string } };
          };
          (row.revisions as Rev[]).push({ ...created, createdById: created.createdBy?.connect.id });
          return clone(row);
        }
      ),
    },
    skillSource: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === state.source.id ? clone(state.source) : null
      ),
      update: vi.fn(
        async ({
          data,
          where,
        }: {
          data: Record<string, unknown>;
          where: { id: string; latestSha?: string; pinnedSha?: string; status?: { not: string } };
        }) => {
          writes.push('source.update');
          const s = state.source;
          if (
            s.id !== where.id ||
            (where.latestSha !== undefined && s.latestSha !== where.latestSha) ||
            (where.pinnedSha !== undefined && s.pinnedSha !== where.pinnedSha) ||
            (where.status && s.status === where.status.not)
          ) {
            throw p2025();
          }
          Object.assign(s, data);
          return clone(s);
        }
      ),
    },
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
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer token' },
      method,
      payload: payload as never,
      url: `/api/v1/platform/skill-sources/${SOURCE_ID}${url}`,
    });
  const skill = (name: string) => state.skills.find((s) => s.name === name) as Row;
  const revisions = (name: string) => skill(name).revisions as Rev[];
  return { call, prisma, revisions, skill, state, writes };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveSetting.mockResolvedValue(true);
  scanSkillContent.mockResolvedValue({ incomplete: false, safe: true, warnings: [] });
  fetchSkillSource.mockResolvedValue(fetched([upstream('alpha'), upstream('beta')]));
});

describe('access', () => {
  it.each([
    ['GET', '/diff'],
    ['POST', '/accept'],
    ['POST', '/check'],
  ] as const)('%s %s is ADMIN-only', async (method, url) => {
    const { call, prisma, writes } = await buildApp('ENGINEER');
    const res = await call(method, url, { sha: NEW });
    expect(res.statusCode).toBe(403);
    expect(fetchSkillSource).not.toHaveBeenCalled();
    expect(resolveSourceSha).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});

describe('POST /:id/check', () => {
  it('flags a moved ref and returns the source', async () => {
    resolveSourceSha.mockResolvedValue(NEWER);
    const { call, state } = await buildApp();
    state.source.latestSha = null;
    state.source.status = 'OK';
    const res = await call('POST', '/check');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      check: { error: null, status: 'UPDATE_AVAILABLE' },
      recorded: true,
      source: { latestSha: NEWER, pinnedSha: OLD, status: 'UPDATE_AVAILABLE' },
    });
    expect(resolveSourceSha).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', ref: 'main' }),
      undefined
    );
    // The cheap check: no tree or blobs, no skill writes.
    expect(fetchSkillSource).not.toHaveBeenCalled();
  });

  it('records a failure as ERROR with the fixed string', async () => {
    resolveSourceSha.mockRejectedValue(new SkillSourceError('NOT_FOUND'));
    const { call, writes } = await buildApp();
    const res = await call('POST', '/check');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      recorded: true,
      source: {
        lastError: 'repository, ref or path not found, or not accessible',
        status: 'ERROR',
      },
    });
    expect(writes).toEqual(['source.update']);
  });

  it('a rate-limit answer records only lastCheckedAt and keeps UPDATE_AVAILABLE and latestSha', async () => {
    resolveSourceSha.mockRejectedValue(new SkillSourceError('RATE_LIMIT_LOW'));
    const { call, state } = await buildApp();
    const res = await call('POST', '/check');
    expect(res.json().data).toMatchObject({
      check: { status: 'SKIPPED' },
      recorded: true,
      source: { lastError: null, latestSha: NEW, status: 'UPDATE_AVAILABLE' },
    });
    expect(state.source.lastCheckedAt).toBeInstanceOf(Date);
  });

  it('says recorded:false when the source changed under the check, and writes nothing', async () => {
    const { call, state } = await buildApp();
    resolveSourceSha.mockImplementation(async () => {
      // An admin disables the source while the host is being asked.
      state.source.status = 'DISABLED';
      return NEWER;
    });
    const res = await call('POST', '/check');
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      check: { status: 'UPDATE_AVAILABLE' },
      recorded: false,
      source: { latestSha: NEW, status: 'DISABLED' },
    });
  });

  it('refuses a disabled source and an unknown one', async () => {
    const { call, state } = await buildApp();
    state.source.status = 'DISABLED';
    expect((await call('POST', '/check')).statusCode).toBe(409);
    expect(resolveSourceSha).not.toHaveBeenCalled();
    state.source.id = '00000000-0000-4000-a000-0000000000c2';
    expect((await call('POST', '/check')).statusCode).toBe(404);
  });
});

describe('GET /:id/diff', () => {
  it('classifies unchanged, changed, added and removed, and writes nothing', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([
        upstream('alpha'),
        upstream('beta', { description: 'beta v2', promptText: 'Prompt for beta\nand more' }),
        upstream('gamma'),
      ])
    );
    const { call, prisma, state, writes } = await buildApp();
    state.skills.push(installedSkill('delta'));
    const res = await call('GET', '/diff');
    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.sha).toBe(NEW);
    expect(data.source).toMatchObject({ latestSha: NEW, pinnedSha: OLD });
    expect(data.unchanged.map((u: { name: string }) => u.name)).toEqual(['alpha']);
    expect(data.changed).toHaveLength(1);
    expect(data.changed[0]).toMatchObject({
      description: { changed: true, new: 'beta v2', old: 'beta description' },
      handEdited: false,
      installedRevision: 1,
      name: 'beta',
      textLength: { new: 'Prompt for beta\nand more'.length, old: 'Prompt for beta'.length },
    });
    expect(data.changed[0].textDiff).toContain(' Prompt for beta');
    expect(data.changed[0].textDiff).toContain('+and more');
    expect(data.added.map((a: { name: string }) => a.name)).toEqual(['gamma']);
    expect(data.removed).toEqual([
      { folder: 'skills/delta', name: 'delta', skillId: 'skill-delta' },
    ]);
    // Nothing written; the installed skills are untouched.
    expect(writes).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.skills.map((s) => s.name)).toEqual(['alpha', 'beta', 'delta']);
    expect(state.source).toMatchObject({ pinnedSha: OLD, status: 'UPDATE_AVAILABLE' });
  });

  it('reads the latest commit by sha, never through the ref, or an explicit ?sha=', async () => {
    const { call } = await buildApp();
    await call('GET', '/diff');
    expect(fetchSkillSource).toHaveBeenLastCalledWith(
      expect.objectContaining({ owner: 'acme', path: 'skills' }),
      { atSha: NEW, scriptMode: 'TEXT_ONLY' },
      undefined
    );
    await call('GET', `/diff?sha=${NEWER}`);
    expect(fetchSkillSource).toHaveBeenLastCalledWith(
      expect.anything(),
      { atSha: NEWER, scriptMode: 'TEXT_ONLY' },
      undefined
    );
    expect((await call('GET', '/diff?sha=main')).statusCode).toBe(400);
  });

  it('409s when no commit was ever recorded', async () => {
    const { call, state } = await buildApp();
    state.source.latestSha = null;
    const res = await call('GET', '/diff');
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SKILL_SOURCE_NOT_CHECKED');
    expect(fetchSkillSource).not.toHaveBeenCalled();
  });

  it('reports scan warnings for every changed and added text', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([
        upstream('alpha', { promptText: 'changed alpha' }),
        upstream('beta'),
        upstream('gamma', { promptText: 'new gamma' }),
      ])
    );
    scanSkillContent.mockImplementation(async (text: string) => ({
      incomplete: false,
      safe: false,
      warnings: text.includes('changed alpha') || text.includes('new gamma') ? ['injection:x'] : [],
    }));
    const { call } = await buildApp();
    const { data } = (await call('GET', '/diff')).json();
    expect(data.changed[0]).toMatchObject({ blockedByScan: true, scanWarnings: ['injection:x'] });
    expect(data.added[0].scanWarnings).toEqual(['injection:x']);
    // beta is unchanged and was not scanned.
    expect(scanSkillContent).toHaveBeenCalledTimes(2);
  });

  it('a reference-file change alone makes a skill changed, and names the files', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([
        upstream('alpha', {
          referenceFiles: [
            { content: 'ref text v2', path: 'notes.md' },
            { content: 'new', path: 'extra.md' },
          ],
        }),
        upstream('beta'),
      ])
    );
    const { call } = await buildApp();
    const { data } = (await call('GET', '/diff')).json();
    expect(data.changed[0].name).toBe('alpha');
    expect(data.changed[0].referenceFiles).toEqual({
      added: ['extra.md'],
      changed: ['notes.md'],
      removed: [],
    });
    expect(data.changed[0].textDiff).toBe('');
  });

  it('flags a hand-edited skill that changed upstream, and ignores one upstream left alone', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([upstream('alpha', { promptText: 'upstream v2' }), upstream('beta')])
    );
    const { call, skill, revisions } = await buildApp();
    // Both skills were edited by hand: alpha's text, beta's text.
    for (const name of ['alpha', 'beta']) {
      skill(name).promptText = 'my edit';
      skill(name).currentRevision = 2;
      revisions(name).push({
        ...(revisions(name)[0] as Rev),
        contentHash: 'edited',
        promptText: 'my edit',
        revision: 2,
        sourcePath: null,
        sourceSha: null,
      });
    }
    const { data } = (await call('GET', '/diff')).json();
    expect(
      data.changed.map((c: { name: string; handEdited: boolean }) => [c.name, c.handEdited])
    ).toEqual([['alpha', true]]);
    // Upstream's text for beta is what was imported, so there is nothing to take.
    expect(data.unchanged).toEqual([
      { handEdited: true, name: 'beta', renamedTo: null, skillId: 'skill-beta' },
    ]);
    expect(data.changed[0].textDiff).toContain('-my edit');
  });

  it('a description-only edit (provenance carried) still counts as hand-edited', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([upstream('alpha', { promptText: 'upstream v2' }), upstream('beta')])
    );
    const { call, skill, revisions } = await buildApp();
    skill('alpha').description = 'my description';
    skill('alpha').currentRevision = 2;
    revisions('alpha').push({
      ...(revisions('alpha')[0] as Rev),
      contentHash: 'desc-edit',
      description: 'my description',
      revision: 2,
    });
    const { data } = (await call('GET', '/diff')).json();
    expect(data.changed[0]).toMatchObject({ handEdited: true, name: 'alpha' });
  });

  it('lists an installed skill that no longer parses as an error, and shows repository text safely', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([
        upstream('alpha', { errors: ['SKILL.md has no YAML frontmatter'], name: null }),
        upstream('beta'),
        upstream('x', { folder: 'skills/bad\u001b[2Kdir' }),
      ])
    );
    const { call } = await buildApp();
    const { data } = (await call('GET', '/diff')).json();
    expect(data.errors).toEqual([
      {
        errors: ['SKILL.md has no YAML frontmatter'],
        folder: 'skills/alpha',
        name: 'alpha',
        skillId: 'skill-alpha',
      },
    ]);
    expect(data.added[0].folder).toBe('skills/bad?[2Kdir');
  });

  it('a fetch failure is its fixed string', async () => {
    fetchSkillSource.mockRejectedValue(new SkillSourceError('NOT_FOUND'));
    const { call } = await buildApp();
    const res = await call('GET', '/diff');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SKILL_SOURCE_NOT_FOUND');
  });
});

describe('POST /:id/accept', () => {
  const changedAlpha = () =>
    fetchSkillSource.mockResolvedValue(
      fetched([
        upstream('alpha', { description: 'alpha v2', promptText: 'alpha v2 text' }),
        upstream('beta'),
      ])
    );

  it('cuts a new unverified revision with provenance, moves the pin and audits', async () => {
    changedAlpha();
    const { call, revisions, skill, state } = await buildApp();
    const res = await call('POST', '/accept', { sha: NEW });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({
      accepted: [{ fromRevision: 1, name: 'alpha', revision: 2 }],
      after: { pinnedSha: NEW, status: 'OK' },
      conflicts: [],
      pinAdvanced: true,
    });
    expect(skill('alpha')).toMatchObject({
      currentRevision: 2,
      description: 'alpha v2',
      isVerified: false,
      promptText: 'alpha v2 text',
    });
    expect(revisions('alpha')[1]).toMatchObject({
      createdById: 'user-1',
      referenceFiles: REF,
      revision: 2,
      sourcePath: 'skills/alpha',
      sourceSha: NEW,
    });
    // beta was unchanged upstream: no new revision, still verified.
    expect(revisions('beta')).toHaveLength(1);
    expect(skill('beta').isVerified).toBe(true);
    expect(state.source).toMatchObject({ lastError: null, pinnedSha: NEW, status: 'OK' });
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({
      action: 'UPDATE',
      afterJson: { pinnedSha: NEW, sha: NEW, skills: [{ name: 'alpha', revision: 2 }] },
      beforeJson: { pinnedSha: OLD, status: 'UPDATE_AVAILABLE' },
      entityId: SOURCE_ID,
      entityType: 'SkillSource',
    });
  });

  it('reads the commit by sha and never through the ref', async () => {
    changedAlpha();
    const { call } = await buildApp();
    await call('POST', '/accept', { sha: NEW });
    expect(fetchSkillSource).toHaveBeenCalledWith(
      expect.anything(),
      { atSha: NEW, scriptMode: 'TEXT_ONLY' },
      undefined
    );
  });

  it('409s when the sha is not the latest the admin diffed, before fetching or writing', async () => {
    const { call, prisma, writes } = await buildApp();
    const res = await call('POST', '/accept', { sha: NEWER });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'SKILL_UPDATE_STALE_SHA',
      details: { latestSha: NEW },
    });
    expect(fetchSkillSource).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('refuses a disabled source', async () => {
    const { call, state } = await buildApp();
    state.source.status = 'DISABLED';
    const res = await call('POST', '/accept', { sha: NEW });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SKILL_UPDATE_DISABLED');
    expect(fetchSkillSource).not.toHaveBeenCalled();
  });

  it('refuses when scan warnings block, and writes nothing', async () => {
    changedAlpha();
    scanSkillContent.mockResolvedValue({
      incomplete: false,
      safe: false,
      warnings: ['injection:x'],
    });
    const { call, state, writes, revisions } = await buildApp();
    const res = await call('POST', '/accept', { sha: NEW });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'SKILL_UPDATE_SCAN_WARNINGS',
      details: [{ name: 'alpha', warnings: ['injection:x'] }],
    });
    expect(writes).toEqual([]);
    expect(revisions('alpha')).toHaveLength(1);
    expect(state.source.pinnedSha).toBe(OLD);
  });

  it('applies warnings when the setting is off, recording them on the revision', async () => {
    changedAlpha();
    resolveSetting.mockResolvedValue(false);
    scanSkillContent.mockResolvedValue({
      incomplete: false,
      safe: false,
      warnings: ['injection:x'],
    });
    const { call, revisions } = await buildApp();
    expect((await call('POST', '/accept', { sha: NEW })).statusCode).toBe(200);
    expect(revisions('alpha')[1]).toMatchObject({ scanWarnings: ['injection:x'] });
  });

  describe('hand-edited skills', () => {
    function handEdit(f: Awaited<ReturnType<typeof buildApp>>, name = 'alpha') {
      f.skill(name).promptText = 'my edit';
      f.skill(name).currentRevision = 2;
      f.revisions(name).push({
        ...(f.revisions(name)[0] as Rev),
        contentHash: 'edited',
        promptText: 'my edit',
        revision: 2,
        sourcePath: null,
        sourceSha: null,
      });
    }

    it('are reported as conflicts, not overwritten, and the pin stays', async () => {
      changedAlpha();
      const f = await buildApp();
      handEdit(f);
      const res = await f.call('POST', '/accept', { sha: NEW });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        accepted: [],
        after: { pinnedSha: OLD, status: 'UPDATE_AVAILABLE' },
        conflicts: ['alpha'],
        pinAdvanced: false,
      });
      expect(f.skill('alpha').promptText).toBe('my edit');
      expect(f.revisions('alpha')).toHaveLength(2);
      expect(f.state.source).toMatchObject({ pinnedSha: OLD, status: 'UPDATE_AVAILABLE' });
    });

    it('are overwritten only when listed explicitly', async () => {
      changedAlpha();
      const f = await buildApp();
      handEdit(f);
      const res = await f.call('POST', '/accept', {
        sha: NEW,
        skills: [{ name: 'alpha', revision: 2 }],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        accepted: [{ fromRevision: 2, name: 'alpha', revision: 3 }],
        conflicts: [],
        pinAdvanced: true,
      });
      expect(f.skill('alpha').promptText).toBe('alpha v2 text');
      // The hand edit stays in history.
      expect(f.revisions('alpha')[1]?.promptText).toBe('my edit');
    });

    it('a concurrent hand edit during the accept makes it 409 and rolls everything back', async () => {
      fetchSkillSource.mockResolvedValue(
        fetched([
          upstream('alpha', { promptText: 'alpha v2 text' }),
          upstream('beta', { promptText: 'beta v2 text' }),
        ])
      );
      const f = await buildApp();
      // The edit lands after the accept has read the skills (during its scan) and
      // before its writes: beta is written, then alpha's guard fails.
      scanSkillContent.mockImplementation(async () => {
        f.skill('beta').currentRevision = 2;
        return { incomplete: false, safe: true, warnings: [] as string[] };
      });
      const res = await f.call('POST', '/accept', { sha: NEW });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('SKILL_CHANGED');
      // alpha was written first and then rolled back with the rest.
      expect(f.skill('alpha')).toMatchObject({
        currentRevision: 1,
        promptText: 'Prompt for alpha',
      });
      expect(f.revisions('alpha')).toHaveLength(1);
      expect(f.state.audit).toHaveLength(0);
      expect(f.state.source).toMatchObject({ pinnedSha: OLD, status: 'UPDATE_AVAILABLE' });
    });
  });

  it('with a subset, updates only those and leaves the pin where it was', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([
        upstream('alpha', { promptText: 'alpha v2 text' }),
        upstream('beta', { promptText: 'beta v2 text' }),
      ])
    );
    const { call, revisions, state } = await buildApp();
    const res = await call('POST', '/accept', {
      sha: NEW,
      skills: [{ name: 'alpha', revision: 1 }],
    });
    expect(res.json().data).toMatchObject({
      accepted: [{ name: 'alpha' }],
      notSelected: ['beta'],
      pinAdvanced: false,
    });
    expect(revisions('beta')).toHaveLength(1);
    expect(state.source).toMatchObject({ pinnedSha: OLD, status: 'UPDATE_AVAILABLE' });
    // The next diff still lists beta.
    const { data } = (await call('GET', '/diff')).json();
    expect(data.changed.map((c: { name: string }) => c.name)).toEqual(['beta']);
  });

  it('refuses names that are not installed from this source, and ones that cannot update', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([upstream('alpha', { errors: ['SKILL.md has no YAML frontmatter'], name: null })])
    );
    const { call, writes } = await buildApp();
    const unknown = await call('POST', '/accept', {
      sha: NEW,
      skills: [{ name: 'nope', revision: 1 }],
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toMatchObject({ details: ['nope'] });
    const broken = await call('POST', '/accept', {
      sha: NEW,
      skills: [{ name: 'alpha', revision: 1 }],
    });
    expect(broken.statusCode).toBe(422);
    const removed = await call('POST', '/accept', {
      sha: NEW,
      skills: [{ name: 'beta', revision: 1 }],
    });
    expect(removed.statusCode).toBe(422);
    expect(writes).toEqual([]);
  });

  it('never deletes a removed skill and never installs an added one', async () => {
    fetchSkillSource.mockResolvedValue(fetched([upstream('alpha'), upstream('gamma')]));
    const { call, state } = await buildApp();
    const res = await call('POST', '/accept', { sha: NEW });
    expect(res.json().data).toMatchObject({
      added: ['skills/gamma'],
      pinAdvanced: true,
      removed: ['beta'],
    });
    expect(state.skills.map((s) => s.name)).toEqual(['alpha', 'beta']);
  });

  it('keeps the previous revision exactly as it was, which is what a running workflow pinned', async () => {
    changedAlpha();
    const { call, revisions } = await buildApp();
    const before = structuredClone(revisions('alpha')[0]);
    await call('POST', '/accept', { sha: NEW });
    // Runs read their pinned revision from the immutable revision rows (PR 1), and
    // an accept only ever appends one.
    expect(revisions('alpha')[0]).toEqual(before);
    expect(revisions('alpha')[0]).toMatchObject({ promptText: 'Prompt for alpha', revision: 1 });
  });

  it('maps a fetch failure to its fixed string and writes nothing', async () => {
    fetchSkillSource.mockRejectedValue(new SkillSourceError('RATE_LIMIT_LOW'));
    const { call, writes } = await buildApp();
    const res = await call('POST', '/accept', { sha: NEW });
    expect(res.statusCode).toBe(503);
    expect(writes).toEqual([]);
  });
});

describe('review bounds and binding', () => {
  const longLines = (n: number, p: string) =>
    Array.from({ length: n }, (_, i) => `${p}${i}-${'x'.repeat(100)}`).join('\n');

  /** Make the installed pristine text of `name` something large. */
  function setPristine(f: Awaited<ReturnType<typeof buildApp>>, name: string, text: string) {
    f.skill(name).promptText = text;
    const rev = f.revisions(name)[0] as Rev;
    rev.promptText = text;
    rev.contentHash = skillContentHash({
      description: f.skill(name).description as string,
      promptText: text,
    });
  }

  it('a rewrite past the edit cap is reported diffTooLarge, with no text to mislead', async () => {
    const old = longLines(1100, 'old');
    fetchSkillSource.mockResolvedValue(
      fetched([upstream('alpha', { promptText: longLines(1100, 'new') }), upstream('beta')])
    );
    const f = await buildApp();
    setPristine(f, 'alpha', old);
    const { data } = (await f.call('GET', '/diff')).json();
    expect(data.changed[0]).toMatchObject({
      diffIncomplete: true,
      diffTooLarge: true,
      name: 'alpha',
      textDiff: '',
    });
  });

  it('a diff cut at the size cap is flagged incomplete and still starts at the first change', async () => {
    const a = Array.from({ length: 500 }, (_, i) => `line ${i} ${'y'.repeat(400)}`);
    const b = a.map((l, i) => (i % 2 ? `${l}!` : l));
    fetchSkillSource.mockResolvedValue(
      fetched([upstream('alpha', { promptText: b.join('\n') }), upstream('beta')])
    );
    const f = await buildApp();
    setPristine(f, 'alpha', a.join('\n'));
    const { data } = (await f.call('GET', '/diff')).json();
    expect(data.changed[0]).toMatchObject({
      diffIncomplete: true,
      diffTooLarge: false,
      textDiffTruncated: true,
    });
    expect(data.changed[0].textDiff.length).toBeLessThanOrEqual(60_000);
    expect(data.changed[0].textDiff).toContain('+line 1 ');
  });

  describe('accept refuses what the admin could not read in full', () => {
    async function oversized() {
      fetchSkillSource.mockResolvedValue(
        fetched([upstream('alpha', { promptText: longLines(1100, 'new') }), upstream('beta')])
      );
      const f = await buildApp();
      setPristine(f, 'alpha', longLines(1100, 'old'));
      return f;
    }

    it('409 DIFF_INCOMPLETE listing the skill, nothing written, unless named', async () => {
      const f = await oversized();
      const res = await f.call('POST', '/accept', { sha: NEW });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({
        code: 'SKILL_UPDATE_DIFF_INCOMPLETE',
        details: ['alpha'],
      });
      expect(f.writes).toEqual([]);
      expect(f.revisions('alpha')).toHaveLength(1);

      const named = await f.call('POST', '/accept', {
        sha: NEW,
        skills: [{ name: 'alpha', revision: 1 }],
      });
      expect(named.statusCode).toBe(200);
      expect(f.revisions('alpha')).toHaveLength(2);
    });

    it('the complete incoming text is readable with skill and full=true', async () => {
      const f = await oversized();
      const res = await f.call('GET', `/diff?skill=alpha&full=true`);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({
        folder: 'skills/alpha',
        name: 'alpha',
        promptText: longLines(1100, 'new'),
        sha: NEW,
      });
      expect(f.writes).toEqual([]);
      expect((await f.call('GET', '/diff?full=true')).statusCode).toBe(400);
      expect((await f.call('GET', '/diff?skill=nope&full=true')).statusCode).toBe(400);
    });
  });

  it('a named skill is bound to the installed revision the admin saw (409 SKILL_CHANGED, nothing written)', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([upstream('alpha', { promptText: 'alpha v2 text' }), upstream('beta')])
    );
    const f = await buildApp();
    // Another admin edits alpha after the diff was read: it is now revision 2.
    f.skill('alpha').currentRevision = 2;
    const res = await f.call('POST', '/accept', {
      sha: NEW,
      skills: [{ name: 'alpha', revision: 1 }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'SKILL_CHANGED',
      details: { names: ['alpha'] },
    });
    expect(f.writes).toEqual([]);
  });

  it('names must carry a revision', async () => {
    const f = await buildApp();
    expect((await f.call('POST', '/accept', { sha: NEW, skills: ['alpha'] })).statusCode).toBe(400);
  });

  it('shows an upstream rename, keeps the installed name and says so', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([
        upstream('alpha', { name: 'alpha-renamed', promptText: 'alpha v2 text' }),
        upstream('beta', { name: 'beta-renamed' }),
      ])
    );
    const f = await buildApp();
    const { data } = (await f.call('GET', '/diff')).json();
    expect(data.changed[0]).toMatchObject({ name: 'alpha', renamedTo: 'alpha-renamed' });
    expect(data.unchanged[0]).toMatchObject({ name: 'beta', renamedTo: 'beta-renamed' });
    const res = await f.call('POST', '/accept', { sha: NEW });
    expect(res.json().data.renamed).toEqual([
      { name: 'alpha', renamedTo: 'alpha-renamed' },
      { name: 'beta', renamedTo: 'beta-renamed' },
    ]);
    expect(f.skill('alpha').name).toBe('alpha');
  });

  it('a source with no recorded commit answers NOT_CHECKED, not a stale sha', async () => {
    const f = await buildApp();
    f.state.source.latestSha = null;
    const res = await f.call('POST', '/accept', { sha: NEW });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SKILL_UPDATE_NOT_CHECKED');
  });

  it('the audit entry records what was left alone, flagged or renamed', async () => {
    fetchSkillSource.mockResolvedValue(
      fetched([
        upstream('alpha', { promptText: 'alpha v2 text' }),
        upstream('beta', { promptText: 'beta v2 text' }),
      ])
    );
    const f = await buildApp();
    f.state.skills.push(installedSkill('delta'));
    await f.call('POST', '/accept', { sha: NEW, skills: [{ name: 'alpha', revision: 1 }] });
    expect(f.state.audit[0]).toMatchObject({
      afterJson: { notSelected: ['beta'], removed: ['delta'], unreadable: [] },
    });
  });
});
