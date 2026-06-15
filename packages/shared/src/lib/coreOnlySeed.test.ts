import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_SCANNER_PATTERNS } from '../scannerPatterns/index.js';
import { seedCoreDefaults, seedSweStarter } from './syncBuiltins.js';

/**
 * Headline proof of de-domainification (P0/WS6): the platform's *core* seed is
 * domain-agnostic. Seeding only core defaults must produce the cross-cutting
 * scanner patterns and **no SWE content** (skills, templates, tool configs, or
 * code-security patterns). All SWE rows are tagged origin='swe-starter'.
 *
 * (The complementary "engine boots with zero SWE agents" proof lands in P2,
 * when the hardcoded SWE steps become template content; in P0 the registered
 * steps still resolve SWE agents, so assertConfigReady still requires them.)
 */

interface Captured {
  scannerCreates: Array<{ type: string; origin: string | null }>;
  scannerUpdates: Array<{ origin: string | null }>;
  skillCreates: number;
  skillOrigins: Array<string | null>;
  templateCreates: number;
  templateOrigins: Array<string | null>;
  assignmentOrigins: Array<string | null>;
  toolConfigCreates: number;
  toolConfigOrigins: Array<string | null>;
  agentCreates: number;
  agentOrigins: Array<string | null>;
}

function makeMockPrisma() {
  const cap: Captured = {
    agentCreates: 0,
    agentOrigins: [],
    assignmentOrigins: [],
    scannerCreates: [],
    scannerUpdates: [],
    skillCreates: 0,
    skillOrigins: [],
    templateCreates: 0,
    templateOrigins: [],
    toolConfigCreates: 0,
    toolConfigOrigins: [],
  };
  const prisma = {
    agent: {
      create: vi.fn(async ({ data }: { data: { origin: string | null } }) => {
        cap.agentCreates += 1;
        cap.agentOrigins.push(data.origin);
        return { id: 'agent-id' };
      }),
      findFirst: vi.fn(async () => null),
    },
    agentSkillAssignment: {
      create: vi.fn(async ({ data }: { data: { origin: string | null } }) => {
        cap.assignmentOrigins.push(data.origin);
        return data;
      }),
      findFirst: vi.fn(async () => null),
    },
    agentToolConfig: {
      create: vi.fn(async ({ data }: { data: { origin: string | null } }) => {
        cap.toolConfigCreates += 1;
        cap.toolConfigOrigins.push(data.origin);
        return data;
      }),
      findFirst: vi.fn(async () => null),
    },
    scannerPattern: {
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: { type: string; origin: string | null };
          update: { origin: string | null };
        }) => {
          cap.scannerCreates.push({ origin: create.origin, type: create.type });
          cap.scannerUpdates.push({ origin: update.origin });
          return create;
        }
      ),
    },
    skill: {
      create: vi.fn(async ({ data }: { data: { id?: string; origin: string | null } }) => {
        cap.skillCreates += 1;
        cap.skillOrigins.push(data.origin);
        return { id: 'skill-id' };
      }),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({ id: 'skill-id' })),
    },
    workflowTemplate: {
      create: vi.fn(async ({ data }: { data: { id?: string; origin: string | null } }) => {
        cap.templateCreates += 1;
        cap.templateOrigins.push(data.origin);
        return { id: 'tmpl-id' };
      }),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({ id: 'tmpl-id' })),
    },
    workflowTemplateVersion: { upsert: vi.fn(async () => ({})) },
  };
  return { cap, prisma: prisma as unknown as PrismaClient };
}

const CORE_PATTERN_COUNT = BUILTIN_SCANNER_PATTERNS.filter(
  (p) => p.type !== 'CODE_SECURITY'
).length;
const CODE_SECURITY_COUNT = BUILTIN_SCANNER_PATTERNS.filter(
  (p) => p.type === 'CODE_SECURITY'
).length;

describe('seedCoreDefaults — core-only deployment', () => {
  it('seeds the cross-cutting scanner patterns and nothing SWE-specific', async () => {
    const { cap, prisma } = makeMockPrisma();
    await seedCoreDefaults(prisma);

    // Every cross-cutting pattern is seeded as a core default (origin=null).
    expect(cap.scannerCreates).toHaveLength(CORE_PATTERN_COUNT);
    expect(cap.scannerCreates.every((p) => p.origin === null)).toBe(true);

    // The four cross-cutting categories are present...
    const types = new Set(cap.scannerCreates.map((p) => p.type));
    expect(types).toEqual(
      new Set(['INJECTION', 'EXFILTRATION', 'SHELL_COMMAND', 'SENSITIVE_FILE'])
    );
    // ...and the SWE-specific code-security patterns are NOT.
    expect(types.has('CODE_SECURITY')).toBe(false);

    // No SWE content of any kind.
    expect(cap.skillCreates).toBe(0);
    expect(cap.templateCreates).toBe(0);
    expect(cap.toolConfigCreates).toBe(0);
    expect(cap.assignmentOrigins).toHaveLength(0);
    expect(cap.agentCreates).toBe(0);
  });
});

describe('seedSweStarter — provenance tagging', () => {
  it('tags every SWE row origin="swe-starter"', async () => {
    const { cap, prisma } = makeMockPrisma();
    await seedSweStarter(prisma);

    expect(cap.skillCreates).toBeGreaterThan(0);
    expect(cap.templateCreates).toBeGreaterThan(0);
    expect(cap.toolConfigCreates).toBe(1);
    expect(cap.assignmentOrigins.length).toBeGreaterThan(0);

    expect(cap.skillOrigins.every((o) => o === 'swe-starter')).toBe(true);
    expect(cap.templateOrigins.every((o) => o === 'swe-starter')).toBe(true);
    expect(cap.toolConfigOrigins.every((o) => o === 'swe-starter')).toBe(true);
    expect(cap.assignmentOrigins.every((o) => o === 'swe-starter')).toBe(true);

    // The SWE agent library rows are seeded and tagged.
    expect(cap.agentCreates).toBeGreaterThan(0);
    expect(cap.agentOrigins.every((o) => o === 'swe-starter')).toBe(true);

    // Only the code-security scanner patterns belong to the SWE starter.
    expect(cap.scannerCreates).toHaveLength(CODE_SECURITY_COUNT);
    expect(cap.scannerCreates.every((p) => p.type === 'CODE_SECURITY')).toBe(true);
    expect(cap.scannerCreates.every((p) => p.origin === 'swe-starter')).toBe(true);
  });
});
