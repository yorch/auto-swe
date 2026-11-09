import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { syncToolCatalog } from './syncBuiltins.js';
import { BUILTIN_TOOLS } from './toolCatalog.js';

/**
 * Seeding the tool catalog from BUILTIN_TOOLS: code owns an untouched built-in row, so a corrected
 * digest reaches every deployment on restart; an admin's edit is never overwritten; an admin's own
 * row for a key@version that later ships built-in is adopted with its values kept; nothing is
 * ever deleted.
 */

interface Row {
  id: string;
  key: string;
  version: string;
  archs: unknown;
  member: string;
  libc: string;
  description: string | null;
  status: string;
  isBuiltIn: boolean;
  isCustomized: boolean;
}

function fakePrisma(
  seed: Partial<Row>[] = [],
  opts: { raceOn?: string; beforeWrite?: (row: Row) => void } = {}
) {
  const rows: Row[] = seed.map((r, i) => ({
    archs: {},
    description: null,
    id: `seed-${i}`,
    isBuiltIn: false,
    isCustomized: false,
    key: '',
    libc: 'any',
    member: '',
    status: 'ACTIVE',
    version: '',
    ...r,
  }));
  const writes: string[] = [];
  const toolCatalogEntry = {
    create: async ({ data }: { data: Partial<Row> }) => {
      const spec = `${data.key}@${data.version}`;
      const withDefaults = { isBuiltIn: false, isCustomized: false, ...data } as Omit<Row, 'id'>;
      if (opts.raceOn === spec) {
        // Another gateway booting at the same moment inserted it first.
        rows.push({ ...withDefaults, id: 'racer' });
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      writes.push(`create ${spec}`);
      const row = { ...withDefaults, id: `new-${rows.length}` };
      rows.push(row);
      return row;
    },
    findMany: async () => rows.map((r) => ({ ...r })),
    updateMany: async ({
      data,
      where,
    }: {
      data: Partial<Row>;
      where: { id: string; isBuiltIn?: boolean; isCustomized?: boolean };
    }) => {
      const row = rows.find((r) => r.id === where.id);
      if (!row) {
        return { count: 0 };
      }
      // An admin's edit lands between the sync's read and its write.
      opts.beforeWrite?.(row);
      if (
        (where.isBuiltIn !== undefined && row.isBuiltIn !== where.isBuiltIn) ||
        (where.isCustomized !== undefined && row.isCustomized !== where.isCustomized)
      ) {
        return { count: 0 };
      }
      writes.push(`update ${row.key}@${row.version}`);
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  return { prisma: { toolCatalogEntry } as unknown as PrismaClient, rows, writes };
}

const JUST = BUILTIN_TOOLS.find((t) => t.key === 'just');
if (!JUST) {
  throw new Error('fixture: just is not in BUILTIN_TOOLS');
}
const SPEC = `${JUST.key}@${JUST.version}`;
const find = (rows: Row[], spec: string) => rows.find((r) => `${r.key}@${r.version}` === spec);

describe('syncToolCatalog', () => {
  it('creates every built-in tool on an empty catalog, then writes nothing on a second run', async () => {
    const { prisma, rows, writes } = fakePrisma();
    await syncToolCatalog(prisma);
    expect(rows).toHaveLength(BUILTIN_TOOLS.length);
    expect(find(rows, SPEC)).toMatchObject({
      archs: JUST.archs,
      isBuiltIn: true,
      isCustomized: false,
      libc: JUST.libc,
      member: JUST.member,
      status: JUST.status,
    });

    writes.length = 0;
    await syncToolCatalog(prisma);
    expect(writes).toEqual([]);
  });

  it('does not rewrite an untouched row whose jsonb came back with its keys reordered', async () => {
    const { amd64, arm64 } = JUST.archs;
    const { prisma, writes } = fakePrisma([
      {
        archs: {
          amd64: { sha256: amd64?.sha256, url: amd64?.url },
          arm64: { sha256: arm64?.sha256, url: arm64?.url },
        },
        description: JUST.description ?? null,
        isBuiltIn: true,
        key: JUST.key,
        libc: JUST.libc,
        member: JUST.member,
        status: JUST.status,
        version: JUST.version,
      },
    ]);
    await syncToolCatalog(prisma);
    expect(writes).toEqual([]);
  });

  it('brings an untouched built-in row in step with a digest corrected in code', async () => {
    const { prisma, rows } = fakePrisma([
      {
        archs: { amd64: { sha256: 'f'.repeat(64), url: 'https://example.com/old.tar.gz' } },
        isBuiltIn: true,
        key: JUST.key,
        member: 'old',
        version: JUST.version,
      },
    ]);
    await syncToolCatalog(prisma);
    expect(find(rows, SPEC)).toMatchObject({
      archs: JUST.archs,
      isCustomized: false,
      member: JUST.member,
    });
  });

  it('never overwrites a built-in row an admin has customized', async () => {
    const { prisma, rows, writes } = fakePrisma([
      {
        isBuiltIn: true,
        isCustomized: true,
        key: JUST.key,
        member: 'bin/just',
        status: 'REVOKED',
        version: JUST.version,
      },
    ]);
    await syncToolCatalog(prisma);
    expect(find(rows, SPEC)).toMatchObject({ member: 'bin/just', status: 'REVOKED' });
    expect(writes).not.toContain(`update ${SPEC}`);
  });

  it("adopts an admin's own row for a key@version that now ships built-in, keeping its values", async () => {
    const mine = { amd64: { sha256: 'a'.repeat(64), url: 'https://mirror.example/just.tar.gz' } };
    const { prisma, rows } = fakePrisma([
      { archs: mine, key: JUST.key, member: 'just', version: JUST.version },
    ]);
    await syncToolCatalog(prisma);
    expect(find(rows, SPEC)).toMatchObject({ archs: mine, isBuiltIn: true, isCustomized: true });
  });

  it('leaves a row alone that an admin revoked between the read and the write', async () => {
    const { prisma, rows, writes } = fakePrisma(
      [
        {
          archs: { amd64: { sha256: 'f'.repeat(64), url: 'https://example.com/old.tar.gz' } },
          isBuiltIn: true,
          key: JUST.key,
          member: 'old',
          status: 'ACTIVE',
          version: JUST.version,
        },
      ],
      {
        beforeWrite: (row) => {
          row.status = 'REVOKED';
          row.isCustomized = true;
        },
      }
    );
    await syncToolCatalog(prisma);
    expect(find(rows, SPEC)).toMatchObject({
      isCustomized: true,
      member: 'old',
      status: 'REVOKED',
    });
    expect(writes).toEqual([]);
  });

  it('does not adopt over a row that stopped being a plain admin row mid-sync', async () => {
    const { prisma, writes } = fakePrisma(
      [{ key: JUST.key, member: 'just', version: JUST.version }],
      {
        beforeWrite: (row) => {
          row.isBuiltIn = true;
        },
      }
    );
    await syncToolCatalog(prisma);
    expect(writes).toEqual([]);
  });

  it('leaves rows that are not built-in alone, and deletes nothing', async () => {
    const { prisma, rows } = fakePrisma([
      { key: 'jq', version: '1.7.1' },
      { isBuiltIn: true, key: 'dropped-from-code', member: 'x', version: '1.0.0' },
    ]);
    await syncToolCatalog(prisma);
    expect(find(rows, 'jq@1.7.1')).toMatchObject({ isBuiltIn: false, isCustomized: false });
    expect(find(rows, 'dropped-from-code@1.0.0')).toMatchObject({ member: 'x' });
  });

  it('carries on past a row a concurrently booting gateway inserted first', async () => {
    const { prisma, rows } = fakePrisma([], { raceOn: SPEC });
    await expect(syncToolCatalog(prisma)).resolves.toBeUndefined();
    expect(rows).toHaveLength(BUILTIN_TOOLS.length);
  });
});
