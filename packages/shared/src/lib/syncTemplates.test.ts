import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';
import {
  CHANNEL_ASSISTANT_SPEC,
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
  RENAMED_TEMPLATES,
  SUPERSEDED_TEMPLATE_DESCRIPTIONS,
  seedSweStarter,
} from './syncBuiltins.js';

interface Row {
  id: string;
  name: string;
  teamId: string | null;
  description: string;
}

/**
 * An in-memory `workflowTemplate` table whose `findFirst` honours its `where`.
 * A fake that ignored the clause would return a row for any name, and the
 * rename and description rules below would pass without ever being exercised.
 */
function makePrisma(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = 0;
  const matches = (row: Row, where: Partial<Row>) =>
    Object.entries(where).every(([k, v]) => row[k as keyof Row] === v);

  const passthrough = {
    create: vi.fn(async () => ({ id: 'x' })),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({ id: 'x' })),
    upsert: vi.fn(async () => ({ id: 'x' })),
  };

  const prisma = {
    agent: passthrough,
    agentSkillRef: passthrough,
    evalRubric: passthrough,
    scannerPattern: passthrough,
    skill: passthrough,
    workflowTemplate: {
      create: vi.fn(async ({ data }: { data: Omit<Row, 'id'> }) => {
        const row = { ...data, id: `new-${nextId++}` };
        rows.push(row);
        return row;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: Partial<Row> }) => rows.find((r) => matches(r, where)) ?? null
      ),
      update: vi.fn(async ({ data, where }: { data: Partial<Row>; where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) {
          throw new Error(`no row ${where.id}`);
        }
        Object.assign(row, data);
        return row;
      }),
    },
    workflowTemplateVersion: passthrough,
  } as unknown as PrismaClient;

  return { prisma, rows };
}

const global = (rows: Row[], name: string) => rows.filter((r) => r.name === name && !r.teamId);

describe('template renames', () => {
  it('renames the legacy row in place instead of creating a second one', async () => {
    const { prisma, rows } = makePrisma([
      { description: 'kept', id: 'legacy', name: 'review-and-merge', teamId: null },
    ]);
    await seedSweStarter(prisma);

    expect(global(rows, 'review-and-merge')).toHaveLength(0);
    const renamed = global(rows, 'agent-reviewed-pr');
    expect(renamed).toHaveLength(1);
    expect(renamed[0].id).toBe('legacy');
  });

  it('leaves a team template with the old name alone', async () => {
    const { prisma, rows } = makePrisma([
      { description: '', id: 'team', name: 'review-and-merge', teamId: 'team-1' },
    ]);
    await seedSweStarter(prisma);

    expect(rows.find((r) => r.id === 'team')?.name).toBe('review-and-merge');
  });

  it('does not rename when the new name already exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { prisma, rows } = makePrisma([
      { description: '', id: 'legacy', name: 'review-and-merge', teamId: null },
      { description: '', id: 'current', name: 'agent-reviewed-pr', teamId: null },
    ]);
    await seedSweStarter(prisma);

    expect(rows.find((r) => r.id === 'legacy')?.name).toBe('review-and-merge');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('only maps to names that are built-in templates', () => {
    const names = new Set(BUILTIN_TEMPLATES.map((t) => t.name));
    for (const [from, to] of Object.entries(RENAMED_TEMPLATES)) {
      expect(names.has(to), to).toBe(true);
      expect(names.has(from), from).toBe(false);
    }
  });
});

describe('superseded descriptions', () => {
  it('replaces a description still carrying the old built-in text', async () => {
    const [old] = SUPERSEDED_TEMPLATE_DESCRIPTIONS['default-engineering'];
    const { prisma, rows } = makePrisma([
      { description: old, id: 'de', name: 'default-engineering', teamId: null },
    ]);
    await seedSweStarter(prisma);

    const current = BUILTIN_TEMPLATES.find((t) => t.name === 'default-engineering');
    expect(rows.find((r) => r.id === 'de')?.description).toBe(current?.description);
  });

  it('keeps a description an admin has edited', async () => {
    const { prisma, rows } = makePrisma([
      { description: 'Our team flow', id: 'de', name: 'default-engineering', teamId: null },
    ]);
    await seedSweStarter(prisma);

    expect(rows.find((r) => r.id === 'de')?.description).toBe('Our team flow');
  });

  it('never lists a current description as superseded', () => {
    for (const [name, olds] of Object.entries(SUPERSEDED_TEMPLATE_DESCRIPTIONS)) {
      const current =
        name === CHANNEL_ASSISTANT_TEMPLATE_NAME
          ? CHANNEL_ASSISTANT_SPEC
          : BUILTIN_TEMPLATES.find((t) => t.name === name);
      expect(current, name).toBeDefined();
      expect(olds).not.toContain(current?.description);
    }
  });
});
