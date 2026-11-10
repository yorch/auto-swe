import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';
import { seedSweStarter } from './syncBuiltins.js';

/**
 * The first fill of a built-in template's input schema (`BUILTIN_TEMPLATES_PREVIOUSLY_WITHOUT_INPUT_SCHEMA`)
 * against real Postgres, on both paths sync takes: the spec unchanged (the schema alone is filled)
 * and the spec changed (a version is appended, the template moves to it, and the schema is filled
 * by a write of its own). On both, the guard `inputSchema: { equals: Prisma.AnyNull }` is what
 * keeps a schema an admin saves concurrently from being overwritten, and the fake client in
 * `syncBuiltins.test.ts` treats every object-valued filter as a match, so only a database shows
 * that the filter matches SQL NULL and JSON `null` and nothing else.
 *
 * Opt in with `SYNC_BUILTINS_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against. It rewrites the GLOBAL `vulnerability-remediation` template's schema, appends
 * built-in versions to it (the last one active, holding the shipped spec), and leaves the shipped
 * schema in place when it finishes:
 *
 *   docker run -d --rm --name sb-pg -e POSTGRES_PASSWORD=t -e POSTGRES_DB=t \
 *     -p 127.0.0.1:55497:5432 pgvector/pgvector:pg18
 *   DATABASE_URL=postgresql://postgres:t@127.0.0.1:55497/t yarn workspace @auto-swe/shared db:deploy
 *   SYNC_BUILTINS_PG_TEST=1 DATABASE_URL=... yarn vitest run \
 *     packages/shared/src/lib/syncBuiltins.pg.test.ts
 */
const enabled = process.env.SYNC_BUILTINS_PG_TEST === '1';

const NAME = 'vulnerability-remediation';
const shipped = BUILTIN_TEMPLATES.find((t) => t.name === NAME)?.inputSchema;
const ADMINS = { properties: { ticketId: { type: 'string' } }, type: 'object' };

async function globalRow() {
  return prisma.workflowTemplate.findFirstOrThrow({ where: { name: NAME, teamId: null } });
}

/** Store the schema column exactly: SQL NULL, JSON `null`, or a value. */
async function setSchema(value: typeof Prisma.DbNull | typeof Prisma.JsonNull | object) {
  const row = await globalRow();
  await prisma.workflowTemplate.update({
    data: { inputSchema: value as Prisma.InputJsonValue },
    where: { id: row.id },
  });
}

/** What the column holds: SQL NULL, JSON `null` (Prisma reads both as JS `null`), or a value. */
async function stored(): Promise<'sql-null' | 'json-null' | 'value'> {
  const { id } = await globalRow();
  const holds = async (n: typeof Prisma.DbNull | typeof Prisma.JsonNull) =>
    (await prisma.workflowTemplate.count({
      where: { id, inputSchema: { equals: n }, teamId: null },
    })) === 1;
  if (await holds(Prisma.DbNull)) {
    return 'sql-null';
  }
  return (await holds(Prisma.JsonNull)) ? 'json-null' : 'value';
}

/**
 * `prisma`, except that an admin's save of {@link ADMINS} lands just before sync's first
 * `workflowTemplate.updateMany` for the row: sync read the old schema, and the row no longer
 * holds it. Each such `updateMany`'s result is pushed to `results`, so a write that moved into a
 * `$transaction` (and so past this proxy) fails the test instead of passing it vacuously.
 */
function racing(rowId: string, results: Array<{ count: number }>): PrismaClient {
  let saved = false;
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop !== 'workflowTemplate') {
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      }
      const delegate = target.workflowTemplate;
      return new Proxy(delegate, {
        get(d, p) {
          const v = Reflect.get(d, p);
          if (p !== 'updateMany') {
            return typeof v === 'function' ? v.bind(d) : v;
          }
          return async (args: Prisma.WorkflowTemplateUpdateManyArgs) => {
            const forThisRow = (args.where as { id?: string } | undefined)?.id === rowId;
            if (forThisRow && !saved) {
              saved = true;
              await target.workflowTemplate.update({
                data: { inputSchema: ADMINS },
                where: { id: rowId },
              });
            }
            const out = await d.updateMany(args);
            if (forThisRow) {
              results.push(out);
            }
            return out;
          };
        },
      });
    },
  }) as PrismaClient;
}

describe.skipIf(!enabled)(
  'seedSweStarter: first fill of a built-in input schema (Postgres)',
  () => {
    beforeAll(async () => {
      expect(shipped).toBeDefined();
      // A fresh database gets the built-ins here; a seeded one is brought to the current spec.
      await seedSweStarter(prisma);
    });
    beforeEach(async () => {
      const row = await globalRow();
      expect(row).toMatchObject({ status: 'ACTIVE', teamId: null });
    });
    afterAll(async () => {
      if (shipped) {
        await setSchema(shipped);
      }
      await prisma.$disconnect();
    });

    it('fills a SQL NULL schema, cutting no version', async () => {
      await setSchema(Prisma.DbNull);
      expect(await stored()).toBe('sql-null');
      const before = await globalRow();
      const versions = await prisma.workflowTemplateVersion.count({
        where: { templateId: before.id },
      });
      await seedSweStarter(prisma);
      expect((await globalRow()).inputSchema).toEqual(shipped);
      expect((await globalRow()).activeVersion).toBe(before.activeVersion);
      expect(await prisma.workflowTemplateVersion.count({ where: { templateId: before.id } })).toBe(
        versions
      );
    });

    it('fills a JSON null schema', async () => {
      await setSchema(Prisma.JsonNull);
      expect(await stored()).toBe('json-null');
      await seedSweStarter(prisma);
      expect((await globalRow()).inputSchema).toEqual(shipped);
    });

    it('leaves a row that has a schema untouched', async () => {
      await setSchema(ADMINS);
      expect(await stored()).toBe('value');
      await seedSweStarter(prisma);
      expect((await globalRow()).inputSchema).toEqual(ADMINS);
    });

    it('does not overwrite a schema saved between the read and the guarded write', async () => {
      await setSchema(Prisma.DbNull);
      const row = await globalRow();
      const results: Array<{ count: number }> = [];
      await seedSweStarter(racing(row.id, results));
      expect(results).toEqual([{ count: 0 }]);
      expect((await globalRow()).inputSchema).toEqual(ADMINS);
    });

    describe('on an upgrade that also changes the spec', () => {
      /**
       * Put the template on an older built-in spec: a built-in version row (no author, not
       * generated) whose spec differs from the shipped one, active. Sync then appends the shipped
       * spec as a new version and moves the template to it, which is the path a real upgrade takes.
       */
      async function onOlderBuiltin(schema: typeof Prisma.DbNull | object) {
        const row = await globalRow();
        const latest = await prisma.workflowTemplateVersion.findFirstOrThrow({
          orderBy: { version: 'desc' },
          where: { templateId: row.id },
        });
        const older = await prisma.workflowTemplateVersion.create({
          data: {
            spec: { ...(latest.spec as object), olderReleaseMarker: true },
            templateId: row.id,
            version: latest.version + 1,
          },
        });
        await prisma.workflowTemplate.update({
          data: { activeVersion: older.version, inputSchema: schema as Prisma.InputJsonValue },
          where: { id: row.id },
        });
        return { id: row.id, older: older.version };
      }

      async function versionCount(templateId: string) {
        return prisma.workflowTemplateVersion.count({ where: { templateId } });
      }

      it('appends a version, moves to it, and fills a NULL schema', async () => {
        const { id, older } = await onOlderBuiltin(Prisma.DbNull);
        const before = await versionCount(id);
        await seedSweStarter(prisma);
        const after = await globalRow();
        expect(await versionCount(id)).toBe(before + 1);
        expect(after.activeVersion).toBe(older + 1);
        expect(after.inputSchema).toEqual(shipped);
      });

      it("moves to the new version but keeps an admin's schema", async () => {
        const { older } = await onOlderBuiltin(ADMINS);
        await seedSweStarter(prisma);
        const after = await globalRow();
        expect(after.activeVersion).toBe(older + 1);
        expect(after.inputSchema).toEqual(ADMINS);
      });

      it('does not overwrite a schema saved between the read and the write', async () => {
        const { id, older } = await onOlderBuiltin(Prisma.DbNull);
        const results: Array<{ count: number }> = [];
        await seedSweStarter(racing(id, results));
        // The version still advances (count 1); the schema fill finds no NULL (count 0).
        expect(results).toEqual([{ count: 1 }, { count: 0 }]);
        const after = await globalRow();
        expect(after.activeVersion).toBe(older + 1);
        expect(after.inputSchema).toEqual(ADMINS);
      });
    });
  }
);
