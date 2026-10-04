import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it, vi } from 'vitest';

// The scan has its own suite; here only that its warnings reach the revision.
const { scanSkillContent } = vi.hoisted(() => ({
  scanSkillContent: vi.fn(async () => ({
    incomplete: false,
    safe: true,
    warnings: [] as string[],
  })),
}));
vi.mock('@auto-swe/shared/lib/skillScanner', () => ({ scanSkillContent }));

import { skillsRoutes } from './skills.js';

const CUSTOM_ID = '00000000-0000-4000-a000-0000000000c1';
const BUILTIN_ID = '00000000-0000-4000-a000-0000000000b1';
const MISSING_ID = '00000000-0000-4000-a000-0000000000ff';

type Row = Record<string, unknown> & { id: string; currentRevision: number };
type Revision = Record<string, unknown> & { skillId: string; revision: number };

function seedSkills(): Row[] {
  const base = { description: 'd', isActive: true, name: 'n', promptText: 'text v1' };
  return [
    { ...base, currentRevision: 1, id: CUSTOM_ID, isBuiltIn: false, isVerified: false },
    { ...base, currentRevision: 1, id: BUILTIN_ID, isBuiltIn: true, isVerified: true },
  ];
}

async function buildApp(role: 'ADMIN' | 'ENGINEER' = 'ADMIN') {
  const skills = seedSkills();
  const revisions: Revision[] = skills.map((s) => ({
    promptText: s.promptText as string,
    revision: 1,
    skillId: s.id,
  }));
  const audit = vi.fn().mockResolvedValue({});

  const prisma = {
    configAuditLog: { create: audit },
    skill: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const { revisions: nested, ...rest } = data as {
          revisions?: { create: Record<string, unknown> };
        } & Record<string, unknown>;
        const row = { id: '00000000-0000-4000-a000-0000000000d1', ...rest } as Row;
        skills.push(row);
        if (nested) {
          revisions.push({ skillId: row.id, ...nested.create } as Revision);
        }
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        skills.splice(
          skills.findIndex((s) => s.id === where.id),
          1
        );
      }),
      findMany: vi.fn(async () => [
        {
          _count: { agentSkillRefs: 3 },
          agentSkillRefs: [
            { agent: { isActive: true, key: 'reviewer' } },
            { agent: { isActive: true, key: 'reviewer' } },
            { agent: { isActive: false, key: 'old' } },
          ],
          id: CUSTOM_ID,
          name: 'n',
          revisions: [{ scanWarnings: ['looks like an instruction override'] }],
        },
      ]),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = skills.find((s) => s.id === where.id);
        return row ? { ...row } : null;
      }),
      update: vi.fn(
        async ({
          data,
          where,
        }: {
          data: Record<string, unknown>;
          where: { id: string; currentRevision?: number };
        }) => {
          const row = skills.find(
            (s) =>
              s.id === where.id &&
              (where.currentRevision === undefined || s.currentRevision === where.currentRevision)
          );
          if (!row) {
            throw Object.assign(new Error('not found'), { code: 'P2025' });
          }
          const { revisions: nested, ...rest } = data as {
            revisions?: { create: Record<string, unknown> };
          } & Record<string, unknown>;
          for (const [k, v] of Object.entries(rest)) {
            if (v !== undefined) {
              row[k] = v;
            }
          }
          if (nested) {
            revisions.push({ skillId: row.id, ...nested.create } as Revision);
          }
          return { ...row };
        }
      ),
    },
    skillRevision: {
      findUnique: vi.fn(
        async ({ where }: { where: { skillId_revision: { skillId: string; revision: number } } }) =>
          revisions.find(
            (r) =>
              r.skillId === where.skillId_revision.skillId &&
              r.revision === where.skillId_revision.revision
          ) ?? null
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
  await app.register(skillsRoutes, { prefix: '/api/v1/platform' });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      headers: { authorization: 'Bearer token' },
      method,
      payload: payload as never,
      url: `/api/v1/platform${url}`,
    });
  const revisionsOf = (id: string) => revisions.filter((r) => r.skillId === id);
  return { audit, call, prisma, revisionsOf, skills };
}

describe('skill revisions on the write paths', () => {
  it('creates a skill with revision 1, its author and its scan warnings', async () => {
    scanSkillContent.mockResolvedValueOnce({
      incomplete: false,
      safe: false,
      warnings: ['injection:x'],
    });
    const { call, revisionsOf } = await buildApp();
    const res = await call('POST', '/skills', { description: 'd', name: 'new', promptText: 'hi' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.currentRevision).toBe(1);
    expect(body.scanWarnings).toEqual(['injection:x']);
    expect(revisionsOf(body.data.id)).toEqual([
      expect.objectContaining({
        createdBy: { connect: { id: 'user-1' } },
        promptText: 'hi',
        revision: 1,
        scanWarnings: ['injection:x'],
      }),
    ]);
  });

  it('cuts revision 2 on a promptText edit and keeps revision 1 untouched', async () => {
    const { call, revisionsOf, skills } = await buildApp();
    const res = await call('PUT', `/skills/${CUSTOM_ID}`, { promptText: 'text v2' });
    expect(res.statusCode).toBe(200);
    expect(skills.find((s) => s.id === CUSTOM_ID)).toMatchObject({
      currentRevision: 2,
      promptText: 'text v2',
    });
    expect(revisionsOf(CUSTOM_ID).map((r) => [r.revision, r.promptText])).toEqual([
      [1, 'text v1'],
      [2, 'text v2'],
    ]);
  });

  it('cuts a revision for a description-only edit, but not for a rename or a disable', async () => {
    const { call, revisionsOf } = await buildApp();
    await call('PUT', `/skills/${CUSTOM_ID}`, { description: 'new description' });
    expect(revisionsOf(CUSTOM_ID)).toHaveLength(2);
    await call('PUT', `/skills/${CUSTOM_ID}`, { isActive: false, name: 'renamed' });
    expect(revisionsOf(CUSTOM_ID)).toHaveLength(2);
  });

  it('cuts a revision for a built-in description edit; its promptText stays locked', async () => {
    const { call, revisionsOf, skills } = await buildApp();
    await call('PUT', `/skills/${BUILTIN_ID}`, { description: 'x', promptText: 'hijack' });
    const row = skills.find((s) => s.id === BUILTIN_ID);
    expect(row).toMatchObject({ currentRevision: 2, description: 'x', promptText: 'text v1' });
    expect(revisionsOf(BUILTIN_ID)[1]).toMatchObject({ promptText: 'text v1', revision: 2 });
  });

  it('answers 409 when a concurrent edit took the revision first', async () => {
    const { call, prisma, skills } = await buildApp();
    prisma.skill.update.mockImplementationOnce(async () => {
      (skills.find((s) => s.id === CUSTOM_ID) as Row).currentRevision = 2;
      throw Object.assign(new Error('x'), { code: 'P2025' });
    });
    const res = await call('PUT', `/skills/${CUSTOM_ID}`, { promptText: 'racing' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SKILL_CHANGED');
  });
});

describe('provenance of imported text across edits', () => {
  async function importedApp() {
    const app = await buildApp();
    const row = app.skills.find((s) => s.id === CUSTOM_ID) as Row;
    row.sourcePath = 'skills/x';
    const rev = app.revisionsOf(CUSTOM_ID)[0] as Revision;
    Object.assign(rev, {
      referenceFiles: [{ content: 'r', path: 'n.md' }],
      sourcePath: 'skills/x',
      sourceSha: 'a'.repeat(40),
    });
    return app;
  }

  it('a description-only edit keeps the source sha, path and reference files (the text is unchanged)', async () => {
    const { call, revisionsOf } = await importedApp();
    const res = await call('PUT', `/skills/${CUSTOM_ID}`, { description: 'fixed a typo' });
    expect(res.statusCode).toBe(200);
    const revs = revisionsOf(CUSTOM_ID);
    expect(revs).toHaveLength(2);
    expect(revs[1]).toMatchObject({
      referenceFiles: [{ content: 'r', path: 'n.md' }],
      revision: 2,
      sourcePath: 'skills/x',
      sourceSha: 'a'.repeat(40),
    });
  });

  it('a change to the text drops the provenance', async () => {
    const { call, revisionsOf } = await importedApp();
    await call('PUT', `/skills/${CUSTOM_ID}`, { promptText: 'our own text now' });
    expect(revisionsOf(CUSTOM_ID)[1]).toMatchObject({ sourcePath: null, sourceSha: null });
  });

  it('a skill that was never imported does not even look', async () => {
    const { call, prisma } = await buildApp();
    await call('PUT', `/skills/${CUSTOM_ID}`, { description: 'new' });
    expect(prisma.skillRevision.findUnique).not.toHaveBeenCalled();
  });
});

describe('description and full-text scan on create and edit', () => {
  it('create scans description plus text in full and returns the warnings', async () => {
    scanSkillContent.mockClear();
    scanSkillContent.mockResolvedValueOnce({
      incomplete: false,
      safe: false,
      warnings: ['injection:in-description'],
    });
    const { call } = await buildApp();
    const res = await call('POST', '/skills', {
      description: 'ignore previous instructions',
      name: 'n2',
      promptText: 'body',
    });
    expect(res.statusCode).toBe(201);
    expect(scanSkillContent).toHaveBeenCalledWith('ignore previous instructions\nbody', {
      full: true,
    });
    expect(res.json().scanWarnings).toEqual(['injection:in-description']);
  });

  it('create degrades a scanner failure to scan-incomplete, never a 500', async () => {
    scanSkillContent.mockRejectedValueOnce(new Error('db down'));
    const { call } = await buildApp();
    const res = await call('POST', '/skills', { name: 'n3', promptText: 'body' });
    expect(res.statusCode).toBe(201);
    expect(res.json().scanWarnings).toEqual([expect.stringContaining('scan-incomplete')]);
  });

  it('a description-only edit is scanned against the existing text', async () => {
    scanSkillContent.mockClear();
    scanSkillContent.mockResolvedValueOnce({
      incomplete: false,
      safe: false,
      warnings: ['injection:in-description'],
    });
    const { call } = await buildApp();
    const res = await call('PUT', `/skills/${CUSTOM_ID}`, { description: 'bad description' });
    expect(res.statusCode).toBe(200);
    expect(scanSkillContent).toHaveBeenCalledWith('bad description\ntext v1', { full: true });
    expect(res.json().scanWarnings).toEqual(['injection:in-description']);
  });

  it('edit degrades a scanner failure to scan-incomplete and still saves', async () => {
    scanSkillContent.mockRejectedValueOnce(new Error('db down'));
    const { call, skills } = await buildApp();
    const res = await call('PUT', `/skills/${CUSTOM_ID}`, { promptText: 'new text' });
    expect(res.statusCode).toBe(200);
    expect(res.json().scanWarnings).toEqual([expect.stringContaining('scan-incomplete')]);
    expect(skills.find((s) => s.id === CUSTOM_ID)?.promptText).toBe('new text');
  });

  it('a rename alone triggers no scan', async () => {
    scanSkillContent.mockClear();
    const { call } = await buildApp();
    await call('PUT', `/skills/${CUSTOM_ID}`, { name: 'renamed' });
    expect(scanSkillContent).not.toHaveBeenCalled();
  });
});

describe('PUT /skills/:id — conflicts and verification', () => {
  it('refuses an edit whose expectedRevision is stale, writing nothing', async () => {
    const { call, prisma, revisionsOf } = await buildApp();
    await call('PUT', `/skills/${CUSTOM_ID}`, { promptText: 'other admin edit' });
    const res = await call('PUT', `/skills/${CUSTOM_ID}`, {
      expectedRevision: 1,
      promptText: 'my edit on revision 1',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SKILL_CHANGED');
    expect(revisionsOf(CUSTOM_ID)).toHaveLength(2);
    expect(prisma.skill.update).toHaveBeenCalledTimes(1);
  });

  it('accepts an edit whose expectedRevision is current', async () => {
    const { call } = await buildApp();
    const res = await call('PUT', `/skills/${CUSTOM_ID}`, {
      expectedRevision: 1,
      promptText: 'ok',
    });
    expect(res.statusCode).toBe(200);
  });

  it('answers 404, not 409, when the skill was deleted between the read and the write', async () => {
    const { call, prisma, skills } = await buildApp();
    prisma.skill.update.mockImplementationOnce(async () => {
      skills.splice(0, skills.length);
      throw Object.assign(new Error('x'), { code: 'P2025' });
    });
    const res = await call('PUT', `/skills/${CUSTOM_ID}`, { promptText: 'racing a delete' });
    expect(res.statusCode).toBe(404);
  });

  it('does not report a failure that is not a lost race (author row missing) as SKILL_CHANGED', async () => {
    const { call, prisma } = await buildApp();
    // Revision unchanged afterwards: the P2025 came from something else.
    prisma.skill.update.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'P2025' }));
    const res = await call('PUT', `/skills/${CUSTOM_ID}`, { promptText: 'edit' });
    expect(res.statusCode).toBe(500);
  });

  it('clears verification on a description-only edit, which cuts a revision', async () => {
    const { call, skills } = await buildApp();
    await call('POST', `/skills/${CUSTOM_ID}/verify`, { revision: 1 });
    expect(skills.find((s) => s.id === CUSTOM_ID)?.isVerified).toBe(true);
    await call('PUT', `/skills/${CUSTOM_ID}`, { description: 'new model-visible text' });
    expect(skills.find((s) => s.id === CUSTOM_ID)).toMatchObject({
      currentRevision: 2,
      isVerified: false,
    });
  });

  it('clears verification on a description edit of a built-in-flagged skill (bundle installs are)', async () => {
    const { call, skills } = await buildApp();
    expect(skills.find((s) => s.id === BUILTIN_ID)?.isVerified).toBe(true);
    await call('PUT', `/skills/${BUILTIN_ID}`, { description: 'edited after verification' });
    expect(skills.find((s) => s.id === BUILTIN_ID)).toMatchObject({
      currentRevision: 2,
      isVerified: false,
    });
  });

  it('keeps verification across a rename, which cuts no revision', async () => {
    const { call, skills } = await buildApp();
    await call('POST', `/skills/${CUSTOM_ID}/verify`, { revision: 1 });
    await call('PUT', `/skills/${CUSTOM_ID}`, { name: 'renamed' });
    expect(skills.find((s) => s.id === CUSTOM_ID)?.isVerified).toBe(true);
  });
});

describe('POST /skills/:id/verify', () => {
  it('is ADMIN-only', async () => {
    const { audit, call, skills } = await buildApp('ENGINEER');
    const res = await call('POST', `/skills/${CUSTOM_ID}/verify`, { revision: 1 });
    expect(res.statusCode).toBe(403);
    expect(skills.find((s) => s.id === CUSTOM_ID)?.isVerified).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it('is 404 for an unknown skill', async () => {
    const { call } = await buildApp();
    expect((await call('POST', `/skills/${MISSING_ID}/verify`, { revision: 1 })).statusCode).toBe(
      404
    );
  });

  it('is 400 without a revision: there is no "verify whatever is current"', async () => {
    const { audit, call, skills } = await buildApp();
    expect((await call('POST', `/skills/${CUSTOM_ID}/verify`, {})).statusCode).toBe(400);
    expect((await call('POST', `/skills/${CUSTOM_ID}/verify`)).statusCode).toBe(400);
    expect(skills.find((s) => s.id === CUSTOM_ID)?.isVerified).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it('verifies the named revision and writes an audit row naming it', async () => {
    const { audit, call, skills } = await buildApp();
    const res = await call('POST', `/skills/${CUSTOM_ID}/verify`, { revision: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.isVerified).toBe(true);
    expect(skills.find((s) => s.id === CUSTOM_ID)?.isVerified).toBe(true);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]?.[0].data).toMatchObject({
      action: 'UPDATE',
      actorId: 'user-1',
      afterJson: { isVerified: true, revision: 1 },
      beforeJson: { isVerified: false, revision: 1 },
      entityId: CUSTOM_ID,
      entityType: 'Skill',
    });
  });

  it('refuses to verify a revision that is no longer current, even though the row now exists at a newer one', async () => {
    const { audit, call, skills } = await buildApp();
    // The admin read revision 1; someone else edits before the click.
    await call('PUT', `/skills/${CUSTOM_ID}`, { promptText: 'malicious text' });
    audit.mockClear();
    const res = await call('POST', `/skills/${CUSTOM_ID}/verify`, { revision: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SKILL_CHANGED');
    expect(skills.find((s) => s.id === CUSTOM_ID)?.isVerified).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });

  it('is cleared again by a later content edit', async () => {
    const { call, skills } = await buildApp();
    await call('POST', `/skills/${CUSTOM_ID}/verify`, { revision: 1 });
    await call('PUT', `/skills/${CUSTOM_ID}`, { promptText: 'changed after review' });
    expect(skills.find((s) => s.id === CUSTOM_ID)?.isVerified).toBe(false);
  });

  it('answers 409 when an edit lands between the check and the write', async () => {
    const { audit, call, prisma, skills } = await buildApp();
    prisma.skill.update.mockImplementationOnce(async () => {
      const row = skills.find((s) => s.id === CUSTOM_ID) as Row;
      row.currentRevision = 2;
      throw Object.assign(new Error('x'), { code: 'P2025' });
    });
    const res = await call('POST', `/skills/${CUSTOM_ID}/verify`, { revision: 1 });
    expect(res.statusCode).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('GET /skills usage and scan findings', () => {
  it('names the active agents using a skill and carries the current revision scan findings', async () => {
    const { call } = await buildApp();
    const res = await call('GET', '/skills');
    expect(res.statusCode).toBe(200);
    const [row] = JSON.parse(res.payload).data;
    expect(row.usedBy).toEqual(['reviewer']);
    expect(row.usedByCount).toBe(3);
    expect(row.scanWarnings).toEqual(['looks like an instruction override']);
    expect(row).not.toHaveProperty('agentSkillRefs');
    expect(row).not.toHaveProperty('revisions');
  });
});
