import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_SKILLS } from '../skills/index.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';
import { seedSweStarter } from './syncBuiltins.js';

/**
 * Admin-owned state must survive a gateway restart: `syncBuiltins` runs on
 * every boot, and it used to re-activate archived templates, reset
 * `activeVersion` to 1, rewrite v1's spec in place, and re-attach skill refs an
 * admin had removed. An in-memory fake — enough of the Prisma surface for the
 * seed — lets each of those be asserted directly.
 */

type Row = Record<string, unknown> & { id: string };

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return true; // relation/operator filters are not needed by the seed
    }
    return (row[k] ?? null) === (v ?? null);
  });
}

function makeFake() {
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const tables = {
    agent: [] as Row[],
    agentSkillRef: [] as Row[],
    autonomyPolicy: [] as Row[],
    evalRubric: [] as Row[],
    scannerPattern: [] as Row[],
    skill: [] as Row[],
    workflowTemplate: [] as Row[],
    workflowTemplateVersion: [] as Row[],
  };
  const orderBys: unknown[] = [];

  function delegate(name: keyof typeof tables) {
    const t = tables[name];
    return {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const { versions, ...rest } = data as {
          versions?: { create: Record<string, unknown> };
        } & Record<string, unknown>;
        if (name === 'workflowTemplateVersion') {
          if (t.some((r) => r.templateId === rest.templateId && r.version === rest.version)) {
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          }
        }
        const row: Row = { createdBy: null, generatedBy: null, id: id(name), ...rest };
        t.push(row);
        if (versions) {
          tables.workflowTemplateVersion.push({
            createdBy: null,
            generatedBy: null,
            id: id('v'),
            templateId: row.id,
            ...versions.create,
          });
        }
        return row;
      },
      findFirst: async (args: { where?: Record<string, unknown>; orderBy?: unknown } = {}) => {
        if (name === 'agent') {
          orderBys.push(args.orderBy);
        }
        const hits = t.filter((r) => matches(r, args.where));
        if (name === 'agent') {
          hits.sort((a, b) => Number(b.version) - Number(a.version));
        }
        return hits[0] ?? null;
      },
      findMany: async (args: { where?: Record<string, unknown> } = {}) =>
        t
          .filter((r) => matches(r, args.where))
          .sort((a, b) => Number(a.version ?? 0) - Number(b.version ?? 0)),
      update: async ({ data, where }: { data: Record<string, unknown>; where: { id: string } }) => {
        const row = t.find((r) => r.id === where.id) as Row;
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        data,
        where,
      }: {
        data: Record<string, unknown>;
        where: Record<string, unknown>;
      }) => {
        const hits = t.filter((r) => matches(r, where));
        for (const r of hits) {
          Object.assign(r, data);
        }
        return { count: hits.length };
      },
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        t.push({ id: id(name), ...create });
        return create;
      },
    };
  }

  const prisma = Object.fromEntries(
    (Object.keys(tables) as Array<keyof typeof tables>).map((k) => [k, delegate(k)])
  ) as unknown as PrismaClient;
  return { orderBys, prisma, tables };
}

const PARALLEL = BUILTIN_TEMPLATES.find((t) => t.name.toLowerCase().includes('parallel'));
const DEFAULT = BUILTIN_TEMPLATES.find((t) => t.isDefault);

function template(tables: ReturnType<typeof makeFake>['tables'], name: string): Row {
  return tables.workflowTemplate.find((t) => t.name === name) as Row;
}
function versionsOf(tables: ReturnType<typeof makeFake>['tables'], templateId: string): Row[] {
  return tables.workflowTemplateVersion.filter((v) => v.templateId === templateId);
}

describe('syncBuiltins — templates', () => {
  it('is a no-op on a second boot: no new versions, nothing re-activated', async () => {
    const { prisma, tables } = makeFake();
    await seedSweStarter(prisma);
    const versionCount = tables.workflowTemplateVersion.length;
    await seedSweStarter(prisma);
    expect(tables.workflowTemplateVersion).toHaveLength(versionCount);
  });

  it('creates exactly one global default', async () => {
    const { prisma, tables } = makeFake();
    await seedSweStarter(prisma);
    expect(tables.workflowTemplate.filter((t) => t.isDefault)).toHaveLength(1);
  });

  it('never creates a second global default when an admin already chose another', async () => {
    const { prisma, tables } = makeFake();
    tables.workflowTemplate.push({
      activeVersion: 1,
      id: 'admin-default',
      isDefault: true,
      name: 'Our own default',
      status: 'ACTIVE',
      teamId: null,
    });
    await seedSweStarter(prisma);
    expect(tables.workflowTemplate.filter((t) => t.isDefault).map((t) => t.id)).toEqual([
      'admin-default',
    ]);
  });

  it('preserves an admin archive, default change and active version across boots', async () => {
    const { prisma, tables } = makeFake();
    await seedSweStarter(prisma);
    const def = template(tables, DEFAULT?.name as string);
    Object.assign(def, { isDefault: false, status: 'ARCHIVED' });
    const par = template(tables, PARALLEL?.name as string);
    // An admin saved their own v2 and activated it.
    tables.workflowTemplateVersion.push({
      createdBy: 'user-1',
      generatedBy: null,
      id: 'admin-v2',
      spec: { mine: true },
      templateId: par.id,
      version: 2,
    });
    par.activeVersion = 2;

    await seedSweStarter(prisma);

    expect(def.status).toBe('ARCHIVED');
    expect(def.isDefault).toBe(false);
    expect(par.activeVersion).toBe(2);
    expect(versionsOf(tables, par.id)).toHaveLength(2);
  });

  it('lands a changed built-in spec as a NEW version and activates it only when still on the old built-in', async () => {
    const { prisma, tables } = makeFake();
    await seedSweStarter(prisma);
    const par = template(tables, PARALLEL?.name as string);
    const v1 = versionsOf(tables, par.id)[0] as Row;
    // Simulate a DB seeded by an older release whose built-in spec differed.
    v1.spec = { old: 'spec' };

    await seedSweStarter(prisma);

    const versions = versionsOf(tables, par.id);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    // v1 is not rewritten in place — a run pinned to it keeps its graph.
    expect(v1.spec).toEqual({ old: 'spec' });
    expect(versions[1]?.spec).toEqual(PARALLEL?.spec);
    expect(par.activeVersion).toBe(2);
  });

  it('adds the new built-in version but leaves activation alone once an admin moved off it', async () => {
    const { prisma, tables } = makeFake();
    await seedSweStarter(prisma);
    const par = template(tables, PARALLEL?.name as string);
    (versionsOf(tables, par.id)[0] as Row).spec = { old: 'spec' };
    tables.workflowTemplateVersion.push({
      createdBy: 'user-1',
      generatedBy: null,
      id: 'admin-v2',
      spec: { mine: true },
      templateId: par.id,
      version: 2,
    });
    par.activeVersion = 2;

    await seedSweStarter(prisma);

    expect(versionsOf(tables, par.id).map((v) => v.version)).toEqual([1, 2, 3]);
    expect(par.activeVersion).toBe(2);
  });

  it('does not re-activate an archived template when its built-in spec changes', async () => {
    const { prisma, tables } = makeFake();
    await seedSweStarter(prisma);
    const par = template(tables, PARALLEL?.name as string);
    (versionsOf(tables, par.id)[0] as Row).spec = { old: 'spec' };
    par.status = 'ARCHIVED';
    await seedSweStarter(prisma);
    expect(par.status).toBe('ARCHIVED');
    expect(par.activeVersion).toBe(1);
  });
});

describe('syncBuiltins — agents and skill refs', () => {
  const assigned = BUILTIN_SKILLS.find((s) => s.assignments.length > 0);

  it('does not re-attach a skill ref an admin removed', async () => {
    const { prisma, tables } = makeFake();
    await seedSweStarter(prisma);
    const refsBefore = tables.agentSkillRef.length;
    expect(refsBefore).toBeGreaterThan(0);
    // Admin detaches one skill from its agent.
    tables.agentSkillRef.splice(0, 1);
    await seedSweStarter(prisma);
    expect(tables.agentSkillRef).toHaveLength(refsBefore - 1);
  });

  it('attaches a newly shipped built-in skill to an existing agent', async () => {
    const { prisma, tables } = makeFake();
    await seedSweStarter(prisma);
    // Pretend this skill did not exist in the previous release.
    const skill = tables.skill.find((s) => s.name === assigned?.name) as Row;
    tables.skill.splice(tables.skill.indexOf(skill), 1);
    const orphaned = tables.agentSkillRef.filter((r) => r.skillId === skill.id);
    for (const r of orphaned) {
      tables.agentSkillRef.splice(tables.agentSkillRef.indexOf(r), 1);
    }
    await seedSweStarter(prisma);
    const recreated = tables.skill.find((s) => s.name === assigned?.name) as Row;
    expect(tables.agentSkillRef.filter((r) => r.skillId === recreated.id)).toHaveLength(
      assigned?.assignments.length ?? 0
    );
  });

  it('does not create a new agent when an admin has versioned or deactivated it', async () => {
    const { prisma, tables } = makeFake();
    await seedSweStarter(prisma);
    const count = tables.agent.length;
    for (const a of tables.agent) {
      a.isActive = false;
    }
    await seedSweStarter(prisma);
    expect(tables.agent).toHaveLength(count);
  });

  it('selects the agent version deterministically (newest first)', async () => {
    const { orderBys, prisma } = makeFake();
    await seedSweStarter(prisma);
    expect(orderBys.every((o) => JSON.stringify(o).includes('"version":"desc"'))).toBe(true);
  });
});
