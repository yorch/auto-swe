import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

/**
 * A small in-memory database for the team directory and join-request tests: just the models and the
 * query shapes `lib/teamJoinRequests.ts`, `routes/teams.ts` and the permissions resolver use. It
 * evaluates `where`, `select`, `orderBy` and `take` for real, so a test fails when a query is wrong
 * and not only when a call is missing, and it enforces the two unique constraints a race falls back
 * on (an open request per user and team, a team membership per user and team).
 *
 * It is a double, not Postgres: the transactional claim is proven against a real database in
 * `lib/teamJoinRequests.pg.test.ts`. Here `$transaction` runs its callback directly, and a test
 * stages a lost race with `world.beforeUpdateMany`.
 */

type Row = Record<string, unknown>;

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type Model =
  | 'organization'
  | 'organizationMembership'
  | 'team'
  | 'teamJoinRequest'
  | 'teamMembership'
  | 'user';

const TABLE: Record<Model, keyof Tables> = {
  organization: 'organizations',
  organizationMembership: 'organizationMemberships',
  team: 'teams',
  teamJoinRequest: 'teamJoinRequests',
  teamMembership: 'teamMemberships',
  user: 'users',
};

/** to-many relation name -> (foreign key on the OTHER model's rows, model it lists) */
const MANY: Partial<Record<Model, Record<string, { fk: string; model: Model }>>> = {
  organization: { teams: { fk: 'orgId', model: 'team' } },
};

/** relation name -> (foreign key on this row, model it points at) */
const RELATIONS: Partial<Record<Model, Record<string, { fk: string; model: Model }>>> = {
  team: { organization: { fk: 'orgId', model: 'organization' } },
  teamJoinRequest: {
    team: { fk: 'teamId', model: 'team' },
    user: { fk: 'userId', model: 'user' },
  },
  teamMembership: {
    team: { fk: 'teamId', model: 'team' },
    user: { fk: 'userId', model: 'user' },
  },
};

export interface Tables {
  audits: Row[];
  organizationMemberships: Row[];
  organizations: Row[];
  teamJoinRequests: Row[];
  teamMemberships: Row[];
  teams: Row[];
  users: Row[];
}

export interface World extends Tables {
  /** The caller: the fake JWT's `sub` and platform role. */
  actor: { role: 'ADMIN' | 'USER'; sub: string };
  /** Runs before a team membership is created, so a test can see what happened first. */
  beforeMembershipCreate?: () => void;
  /** Runs before an `updateMany` is applied, so a test can lose the race on purpose. */
  beforeUpdateMany?: (model: Model, args: { where: Row; data: Row }) => void;
  /** The raw statements executed (lock order), as `statement-text|value`. */
  locks: string[];
  /** When set, the next `teamJoinRequest.create` fails like the open-request unique index. */
  failNextRequestCreate?: boolean;
  seq: number;
  /** Settings, by key or by `key@orgId`; anything missing is the registry default. */
  settings: Record<string, unknown>;
}

export function emptyWorld(): World {
  return {
    actor: { role: 'USER', sub: uuid(1) },
    audits: [],
    locks: [],
    organizationMemberships: [],
    organizations: [],
    seq: 1000,
    settings: {},
    teamJoinRequests: [],
    teamMemberships: [],
    teams: [],
    users: [],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !(v instanceof Date) && !Array.isArray(v);

function uniqueError(): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

function fieldMatches(value: unknown, cond: unknown): boolean {
  if (!isObject(cond)) {
    return value instanceof Date && cond instanceof Date
      ? value.getTime() === cond.getTime()
      : value === cond;
  }
  if ('in' in cond) {
    return (cond.in as unknown[]).includes(value);
  }
  if ('notIn' in cond) {
    return !(cond.notIn as unknown[]).includes(value);
  }
  if ('gt' in cond) {
    return String(value) > String(cond.gt);
  }
  if ('contains' in cond) {
    const needle = String(cond.contains);
    return cond.mode === 'insensitive'
      ? String(value).toLowerCase().includes(needle.toLowerCase())
      : String(value).includes(needle);
  }
  if ('equals' in cond) {
    return value === cond.equals;
  }
  throw new Error(`the test database does not know the filter ${JSON.stringify(cond)}`);
}

export function buildPrisma(world: World) {
  const rows = (model: Model): Row[] => world[TABLE[model]];

  function related(model: Model, row: Row, name: string): { model: Model; row: Row | undefined } {
    const rel = RELATIONS[model]?.[name];
    if (!rel) {
      throw new Error(`${model} has no relation ${name} in the test database`);
    }
    return { model: rel.model, row: rows(rel.model).find((r) => r.id === row[rel.fk]) };
  }

  function matches(model: Model, row: Row, where: Row | undefined): boolean {
    for (const [key, cond] of Object.entries(where ?? {})) {
      if (cond === undefined) {
        continue;
      }
      if (key === 'AND') {
        if (![cond as Row[]].flat().every((w) => matches(model, row, w))) {
          return false;
        }
      } else if (key === 'OR') {
        if (!(cond as Row[]).some((w) => matches(model, row, w))) {
          return false;
        }
      } else if (key === 'userId_orgId' || key === 'userId_teamId') {
        if (!Object.entries(cond as Row).every(([k, v]) => row[k] === v)) {
          return false;
        }
      } else if (model === 'organization' && key === 'configSettings' && isObject(cond)) {
        // The override rows of `world.settings` (`key@orgId`), as `ConfigSetting` rows.
        const stored = Object.entries(world.settings)
          .map(([name, value]) => ({ name: name.split('@'), value }))
          .filter(({ name }) => name[1] === row.id)
          .map(({ name, value }) => ({
            key: name[0],
            orgId: name[1],
            scope: 'ORGANIZATION',
            value,
          }));
        const hit = (w: unknown) =>
          stored.some((r) =>
            Object.entries(w as Row).every(([k, c]) => fieldMatches((r as Row)[k], c))
          );
        if (('some' in cond && !hit(cond.some)) || ('none' in cond && hit(cond.none))) {
          return false;
        }
      } else if (MANY[model]?.[key] && isObject(cond) && 'some' in cond) {
        const rel = MANY[model][key];
        if (
          !rows(rel.model).some(
            (r) => r[rel.fk] === row.id && matches(rel.model, r, cond.some as Row)
          )
        ) {
          return false;
        }
      } else if (RELATIONS[model]?.[key] && isObject(cond)) {
        const rel = related(model, row, key);
        if (!(rel.row && matches(rel.model, rel.row, cond))) {
          return false;
        }
      } else if (!fieldMatches(row[key], cond)) {
        return false;
      }
    }
    return true;
  }

  function project(model: Model, row: Row, select: Row | undefined): Row {
    if (!select) {
      return { ...row };
    }
    const out: Row = {};
    for (const [key, want] of Object.entries(select)) {
      if (want === true) {
        out[key] = row[key];
      } else if (isObject(want) && 'select' in want) {
        const rel = related(model, row, key);
        out[key] = rel.row ? project(rel.model, rel.row, want.select as Row) : null;
      }
    }
    return out;
  }

  function sort(list: Row[], orderBy: Row | Row[] | undefined): Row[] {
    const keys = [orderBy ?? []].flat();
    if (keys.length === 0) {
      return list;
    }
    return [...list].sort((a, b) => {
      for (const clause of keys) {
        const [field, dir] = Object.entries(clause)[0] as [string, 'asc' | 'desc'];
        const x = a[field];
        const y = b[field];
        const cmp =
          x instanceof Date && y instanceof Date
            ? x.getTime() - y.getTime()
            : String(x).localeCompare(String(y));
        if (cmp !== 0) {
          return dir === 'desc' ? -cmp : cmp;
        }
      }
      return 0;
    });
  }

  const find = (model: Model, args: { orderBy?: Row | Row[]; where?: Row }) =>
    sort(
      rows(model).filter((r) => matches(model, r, args.where)),
      args.orderBy
    );

  function delegate(model: Model, extra: Record<string, unknown> = {}) {
    return {
      count: async (args: { where?: Row } = {}) => find(model, args).length,
      findFirst: async (args: { orderBy?: Row | Row[]; select?: Row; where?: Row }) => {
        const hit = find(model, args)[0];
        return hit ? project(model, hit, args.select) : null;
      },
      findFirstOrThrow: async (args: { orderBy?: Row | Row[]; select?: Row; where?: Row }) => {
        const hit = find(model, args)[0];
        if (!hit) {
          throw new Error(`${model} not found`);
        }
        return project(model, hit, args.select);
      },
      findMany: async (args: { orderBy?: Row | Row[]; select?: Row; take?: number; where?: Row }) =>
        find(model, args)
          .slice(0, args.take)
          .map((r) => project(model, r, args.select)),
      findUnique: async (args: { select?: Row; where: Row }) => {
        const hit = find(model, args)[0];
        return hit ? project(model, hit, args.select) : null;
      },
      findUniqueOrThrow: async (args: { select?: Row; where: Row }) => {
        const hit = find(model, args)[0];
        if (!hit) {
          throw new Error(`${model} not found`);
        }
        return project(model, hit, args.select);
      },
      updateMany: async (args: { data: Row; where: Row }) => {
        world.beforeUpdateMany?.(model, args);
        const hits = find(model, args);
        for (const r of hits) {
          Object.assign(r, args.data, { updatedAt: new Date() });
        }
        return { count: hits.length };
      },
      updateManyAndReturn: async (args: { data: Row; select?: Row; where: Row }) => {
        world.beforeUpdateMany?.(model, args);
        const hits = find(model, args);
        for (const r of hits) {
          Object.assign(r, args.data, { updatedAt: new Date() });
        }
        return hits.map((r) => project(model, r, args.select));
      },
      ...extra,
    };
  }

  const nextId = () => uuid(++world.seq);

  const prisma = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      world.locks.push(`${strings.join('?').replace(/\s+/g, ' ').trim()}|${values.join(',')}`);
      return 1;
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    configAuditLog: {
      create: async ({ data }: { data: Row }) => {
        world.audits.push(data);
        return data;
      },
    },
    organization: delegate('organization'),
    organizationMembership: delegate('organizationMembership', {
      create: async ({ data }: { data: Row }) => {
        if (
          rows('organizationMembership').some(
            (m) => m.userId === data.userId && m.orgId === data.orgId
          )
        ) {
          throw uniqueError();
        }
        const row = { id: nextId(), ...data };
        world.organizationMemberships.push(row);
        return row;
      },
      createMany: async ({ data }: { data: Row }) => {
        if (
          world.organizationMemberships.some(
            (m) => m.userId === data.userId && m.orgId === data.orgId
          )
        ) {
          return { count: 0 };
        }
        world.organizationMemberships.push({ id: nextId(), ...data });
        return { count: 1 };
      },
    }),
    team: delegate('team', {
      create: async ({ data }: { data: Row }) => {
        if (world.teams.some((t) => t.name === data.name || t.slug === data.slug)) {
          throw uniqueError();
        }
        const row = { createdById: null, description: '', id: nextId(), isActive: true, ...data };
        world.teams.push(row);
        return row;
      },
      /** Distinct `by` values of the rows `where` selects (only `orgId` is used). */
      groupBy: async ({ by, where }: { by: string[]; where: Row }) => {
        const seen = new Map<string, Row>();
        for (const t of find('team', { where })) {
          const key = by.map((k) => String(t[k])).join('|');
          seen.set(key, Object.fromEntries(by.map((k) => [k, t[k]])));
        }
        return [...seen.values()];
      },
    }),
    teamJoinRequest: delegate('teamJoinRequest', {
      create: async ({ data, select }: { data: Row; select?: Row }) => {
        const open = (r: Row) => r.status === 'PENDING_TEAM' || r.status === 'PENDING_ORG';
        if (
          world.failNextRequestCreate ||
          world.teamJoinRequests.some(
            (r) => open(r) && r.userId === data.userId && r.teamId === data.teamId
          )
        ) {
          world.failNextRequestCreate = false;
          throw uniqueError();
        }
        const now = new Date();
        const row: Row = {
          closeReason: null,
          createdAt: now,
          grantedRole: null,
          id: nextId(),
          message: '',
          orgDecidedAt: null,
          orgDecidedById: null,
          orgDecisionNote: null,
          requiresOrgApproval: false,
          status: 'PENDING_TEAM',
          teamDecidedAt: null,
          teamDecidedById: null,
          teamDecisionNote: null,
          updatedAt: now,
          ...data,
        };
        world.teamJoinRequests.push(row);
        return project('teamJoinRequest', row, select);
      },
    }),
    teamMembership: delegate('teamMembership', {
      create: async ({ data }: { data: Row }) => {
        world.beforeMembershipCreate?.();
        if (
          world.teamMemberships.some((m) => m.userId === data.userId && m.teamId === data.teamId)
        ) {
          throw uniqueError();
        }
        const row = { id: nextId(), ...data };
        world.teamMemberships.push(row);
        return row;
      },
      groupBy: async ({ where }: { where: Row }) => {
        const counts = new Map<unknown, number>();
        for (const m of find('teamMembership', { where })) {
          counts.set(m.teamId, (counts.get(m.teamId) ?? 0) + 1);
        }
        return [...counts].map(([teamId, n]) => ({ _count: { _all: n }, teamId }));
      },
    }),
    user: delegate('user'),
  };
  return prisma;
}

export interface WorldApp {
  app: FastifyInstance;
  prisma: ReturnType<typeof buildPrisma>;
  world: World;
}

/** A Fastify app whose bearer token is always `world.actor`, over the in-memory database. */
export function buildWorldApp(world: World): WorldApp {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const prisma = buildPrisma(world);
  app.decorate('prisma', prisma as never);
  app.decorate('auth', {
    verifyAccessToken: () => ({
      exp: 9_999_999_999,
      iat: 0,
      role: world.actor.role,
      sub: world.actor.sub,
    }),
  } as unknown as never);
  app.addHook('onRequest', async (req) => {
    req.headers.authorization = 'Bearer fake-token';
  });
  return { app, prisma, world };
}
