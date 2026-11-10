import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../db.js';

/**
 * The harness-profile tables against real Postgres: a profile name is unique ignoring case through
 * a hand-written `lower(name)` index (Prisma cannot express it, so a mocked client never sees it),
 * a version number is unique per profile, and a profile that still has versions cannot be deleted
 * (`onDelete: Restrict`), which is what keeps an approved snapshot from vanishing under an Agent
 * version that references it.
 *
 * Opt in with `HARNESS_PROFILE_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against (it writes and deletes rows, so use a throwaway one).
 */
const enabled = process.env.HARNESS_PROFILE_PG_TEST === '1';

describe.skipIf(!enabled)('harness profiles against Postgres', () => {
  const suffix = randomUUID().slice(0, 8);
  const created: string[] = [];

  const profile = async (name: string) => {
    const row = await prisma.harnessProfile.create({
      data: { description: 'd', host: 'github.com', name, owner: 'o', ref: 'main', repo: 'r' },
    });
    created.push(row.id);
    return row;
  };
  const version = (profileId: string, n: number) =>
    prisma.harnessProfileVersion.create({
      data: {
        commitSha: 'a'.repeat(40),
        contentHash: `hash-${n}`,
        fileCount: 1,
        fileIndex: [],
        files: Buffer.from('x'),
        manifest: {},
        profileId,
        totalBytes: 1,
        version: n,
      },
    });

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.harnessProfileVersion.deleteMany({ where: { profileId: { in: created } } });
      await prisma.harnessProfile.deleteMany({ where: { id: { in: created } } });
    }
    await prisma.$disconnect();
  });

  it('refuses a second profile whose name differs only by case', async () => {
    await profile(`Demo-${suffix}`);
    await expect(profile(`demo-${suffix}`)).rejects.toThrow();
    await expect(profile(`DEMO-${suffix}`)).rejects.toThrow();
  });

  it('accepts a different name', async () => {
    await expect(profile(`other-${suffix}`)).resolves.toMatchObject({ status: 'OK' });
  });

  it('refuses a second row for the same profile version', async () => {
    const p = await profile(`versions-${suffix}`);
    await version(p.id, 1);
    await expect(version(p.id, 1)).rejects.toThrow();
    await expect(version(p.id, 2)).resolves.toMatchObject({ version: 2 });
  });

  it('refuses to delete a profile that still has versions', async () => {
    const p = await profile(`restrict-${suffix}`);
    await version(p.id, 1);
    await expect(prisma.harnessProfile.delete({ where: { id: p.id } })).rejects.toThrow();
    await prisma.harnessProfileVersion.deleteMany({ where: { profileId: p.id } });
    await expect(prisma.harnessProfile.delete({ where: { id: p.id } })).resolves.toBeTruthy();
  });
});
