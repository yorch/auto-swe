import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';
import {
  CHANNEL_ASSISTANT_SPEC,
  CHANNEL_ASSISTANT_TEMPLATE_NAME,
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
 * description rules below would pass without ever being exercised.
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

describe('superseded descriptions', () => {
  it('replaces a description still carrying the old built-in text', async () => {
    const [old] = SUPERSEDED_TEMPLATE_DESCRIPTIONS['ticket-to-merge'];
    const { prisma, rows } = makePrisma([
      { description: old, id: 'de', name: 'ticket-to-merge', teamId: null },
    ]);
    await seedSweStarter(prisma);

    const current = BUILTIN_TEMPLATES.find((t) => t.name === 'ticket-to-merge');
    expect(rows.find((r) => r.id === 'de')?.description).toBe(current?.description);
  });

  it('keeps a description an admin has edited', async () => {
    const { prisma, rows } = makePrisma([
      { description: 'Our team flow', id: 'de', name: 'ticket-to-merge', teamId: null },
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
