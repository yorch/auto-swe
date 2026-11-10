import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../db.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';
import { seedSweStarter } from './syncBuiltins.js';

/**
 * The first fill of a built-in template's input schema (`BUILTIN_TEMPLATES_PREVIOUSLY_WITHOUT_INPUT_SCHEMA`)
 * against real Postgres. Its guard, `inputSchema: { equals: Prisma.AnyNull }`, is what keeps a
 * schema an admin saves concurrently from being overwritten, and the fake client in
 * `syncBuiltins.test.ts` treats every object-valued filter as a match, so only a database shows
 * that the filter matches SQL NULL and JSON `null` and nothing else.
 *
 * Opt in with `SYNC_BUILTINS_PG_TEST=1` and a `DATABASE_URL` that `prisma migrate deploy` has been
 * run against. It rewrites the GLOBAL `vulnerability-remediation` template's schema and leaves the
 * shipped one in place when it finishes:
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
      // The admin's save lands just before sync's write: sync read NULL, the row no longer holds it.
      const racing = new Proxy(prisma, {
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
                const forThisRow = (args.where as { id?: string } | undefined)?.id === row.id;
                if (forThisRow) {
                  await target.workflowTemplate.update({
                    data: { inputSchema: ADMINS },
                    where: { id: row.id },
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
      await seedSweStarter(racing);
      expect(results).toEqual([{ count: 0 }]);
      expect((await globalRow()).inputSchema).toEqual(ADMINS);
    });
  }
);
