import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../index.js';
import type { DiscoveredSpec, ProviderDiscovery } from './modelDiscovery.js';
import { recordDiscovery } from './modelSuggestions.js';

type Row = {
  id: string;
  provider: string;
  modelId: string;
  type: 'NEW' | 'RETIREMENT_CANDIDATE';
  kind: string;
  displayName: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  dismissedAt: Date | null;
};
type Status = {
  provider: string;
  checkedAt: Date;
  lastSuccessAt?: Date | null;
  error: string | null;
};

/** The few Prisma calls `recordDiscovery` makes, over arrays. */
function fakeDb() {
  const rows: Row[] = [];
  const statuses: Status[] = [];
  let seq = 0;
  const notIn = (where: { provider?: { notIn: string[] } }, provider: string) =>
    !where.provider?.notIn.includes(provider);
  const prisma = {
    modelDiscoveryProviderStatus: {
      deleteMany: async ({ where }: { where: { provider: { notIn: string[] } } }) => {
        for (const s of statuses.filter((s) => notIn(where, s.provider))) {
          statuses.splice(statuses.indexOf(s), 1);
        }
      },
      upsert: async ({
        create,
        update,
        where,
      }: {
        create: Status;
        update: Partial<Status>;
        where: { provider: string };
      }) => {
        const found = statuses.find((s) => s.provider === where.provider);
        if (found) {
          Object.assign(found, update);
        } else {
          statuses.push({ ...create });
        }
      },
    },
    modelSuggestion: {
      deleteMany: async ({
        where,
      }: {
        where: { provider?: { notIn: string[] }; id?: { in: string[] } };
      }) => {
        for (const r of rows.filter(
          (r) => notIn(where, r.provider) && (!where.id || where.id.in.includes(r.id))
        )) {
          rows.splice(rows.indexOf(r), 1);
        }
      },
      findMany: async ({ where }: { where: { provider: string } }) =>
        rows.filter((r) => r.provider === where.provider).map((r) => ({ ...r })),
      upsert: async ({
        create,
        update,
        where,
      }: {
        create: Omit<Row, 'id' | 'dismissedAt'>;
        update: Partial<Row>;
        where: { provider_modelId: { provider: string; modelId: string } };
      }) => {
        const key = where.provider_modelId;
        const found = rows.find((r) => r.provider === key.provider && r.modelId === key.modelId);
        if (found) {
          Object.assign(found, update);
        } else {
          rows.push({ ...create, dismissedAt: null, id: `r${seq++}` });
        }
      },
    },
  };
  return { prisma: prisma as unknown as PrismaClient, rows, statuses };
}

function dismiss(rows: Row[], at: Date) {
  const [row] = rows;
  if (!row) {
    throw new Error('no row to dismiss');
  }
  row.dismissedAt = at;
}

const spec = (provider: string, modelId: string): DiscoveredSpec => ({
  displayName: null,
  kind: 'CHAT',
  modelId,
  spec: `${provider}/${modelId}`,
});

function ok(
  provider: string,
  models: string[],
  retired: string[] = [],
  complete = true
): ProviderDiscovery {
  return {
    complete,
    models: models.map((m) => spec(provider, m)),
    ok: true,
    provider,
    retirementCandidates: complete ? retired.map((m) => spec(provider, m)) : [],
  };
}

const failed = (provider: string): ProviderDiscovery => ({
  complete: false,
  error: 'HTTP 401',
  models: [],
  ok: false,
  provider,
  retirementCandidates: [],
});

const T1 = new Date('2026-10-01T04:00:00Z');
const T2 = new Date('2026-10-02T04:00:00Z');

const view = (rows: Row[]) => rows.map((r) => `${r.provider}/${r.modelId}:${r.type}`).sort();

describe('recordDiscovery', () => {
  it('stores new and retirement-candidate models and a status row per provider', async () => {
    const { prisma, rows, statuses } = fakeDb();
    const summary = await recordDiscovery(prisma, [ok('openai', ['gpt-9'], ['gpt-1'])], T1);
    expect(view(rows)).toEqual(['openai/gpt-1:RETIREMENT_CANDIDATE', 'openai/gpt-9:NEW']);
    expect(statuses[0]).toMatchObject({ checkedAt: T1, error: null, lastSuccessAt: T1 });
    expect(summary.providers).toEqual([
      { error: undefined, newModels: 1, ok: true, provider: 'openai', retirementCandidates: 1 },
    ]);
  });

  it('keeps firstSeenAt and a dismissal across runs, and refreshes lastSeenAt', async () => {
    const { prisma, rows } = fakeDb();
    await recordDiscovery(prisma, [ok('openai', ['gpt-9'])], T1);
    const dismissedAt = new Date('2026-10-01T09:00:00Z');
    dismiss(rows, dismissedAt);
    await recordDiscovery(prisma, [ok('openai', ['gpt-9'])], T2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ dismissedAt, firstSeenAt: T1, lastSeenAt: T2 });
  });

  it('drops a NEW row once the model is priced or unlisted, and a candidate once listed again', async () => {
    const { prisma, rows } = fakeDb();
    await recordDiscovery(prisma, [ok('openai', ['gpt-9', 'gpt-8'], ['gpt-1'])], T1);
    // gpt-9 got priced (so it is no longer unpriced), gpt-8 left the listing, gpt-1 is back.
    await recordDiscovery(prisma, [ok('openai', [], [])], T2);
    expect(rows).toEqual([]);
  });

  it('never touches a failed provider’s suggestions, and records its error beside the last success', async () => {
    const { prisma, rows, statuses } = fakeDb();
    await recordDiscovery(prisma, [ok('openai', ['gpt-9'], ['gpt-1'])], T1);
    const before = JSON.stringify(rows);
    await recordDiscovery(prisma, [failed('openai')], T2);
    expect(JSON.stringify(rows)).toBe(before);
    expect(statuses[0]).toMatchObject({ checkedAt: T2, error: 'HTTP 401', lastSuccessAt: T1 });
  });

  it('an incomplete listing adds and refreshes NEW rows but retires nothing and flags nothing', async () => {
    const { prisma, rows } = fakeDb();
    await recordDiscovery(prisma, [ok('openai', ['gpt-9'], ['gpt-1'])], T1);
    await recordDiscovery(prisma, [ok('openai', ['gpt-10'], [], false)], T2);
    expect(view(rows)).toEqual([
      'openai/gpt-10:NEW',
      'openai/gpt-1:RETIREMENT_CANDIDATE',
      'openai/gpt-9:NEW',
    ]);
  });

  it('a model that changes type starts undismissed', async () => {
    const { prisma, rows } = fakeDb();
    await recordDiscovery(prisma, [ok('openai', ['gpt-9'])], T1);
    dismiss(rows, T1);
    await recordDiscovery(prisma, [ok('openai', [], ['gpt-9'])], T2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dismissedAt: null,
      firstSeenAt: T2,
      type: 'RETIREMENT_CANDIDATE',
    });
  });

  it('forgets a provider that no longer has a credential', async () => {
    const { prisma, rows, statuses } = fakeDb();
    await recordDiscovery(prisma, [ok('openai', ['gpt-9']), ok('google', ['g-9'])], T1);
    await recordDiscovery(prisma, [ok('google', ['g-9'])], T2);
    expect(view(rows)).toEqual(['google/g-9:NEW']);
    expect(statuses.map((s) => s.provider)).toEqual(['google']);
  });

  it('keeps a dismissed row when a complete listing omits the model, so the dismissal survives its return', async () => {
    const { prisma, rows } = fakeDb();
    await recordDiscovery(prisma, [ok('openai', ['gpt-9', 'gpt-8'])], T1);
    const gpt9 = rows.find((r) => r.modelId === 'gpt-9');
    if (!gpt9) {
      throw new Error('missing row');
    }
    gpt9.dismissedAt = T1;
    await recordDiscovery(prisma, [ok('openai', [])], T2);
    // gpt-8 was not dismissed and is gone; gpt-9 stays, dismissed.
    expect(view(rows)).toEqual(['openai/gpt-9:NEW']);
    await recordDiscovery(prisma, [ok('openai', ['gpt-9'])], T2);
    expect(rows[0]).toMatchObject({ dismissedAt: T1, firstSeenAt: T1 });
  });

  it('moves lastSuccessAt only for a complete listing', async () => {
    const { prisma, statuses } = fakeDb();
    await recordDiscovery(prisma, [ok('openai', ['gpt-9'])], T1);
    await recordDiscovery(prisma, [ok('openai', ['gpt-9'], [], false)], T2);
    expect(statuses[0]).toMatchObject({ checkedAt: T2, error: null, lastSuccessAt: T1 });
  });
});
