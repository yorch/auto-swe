import { Prisma } from '@auto-swe/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The plugin MCP relay's pin end to end: the REAL `harnessProfile.ts` pin code and the REAL
 * `pluginMcp.ts` resolver, with only the database (an in-memory `workflowRun` that implements the
 * compare-and-set the pin code relies on) and the activity context faked. The refusal table at the
 * end fails if the live-set fallback comes back for any reason.
 */

interface Row {
  id: string;
  workflowId: string;
  temporalRunId: string | null;
  harnessProfileVersions: unknown;
}

const h = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  return {
    als: new AsyncLocalStorage<{ runId: string; workflowId: string }>(),
    connectionFind: vi.fn(),
    findFail: undefined as undefined | Error,
    findGate: undefined as undefined | (() => Promise<void>),
    mappingFind: vi.fn(),
    row: { current: null } as { current: Row | null },
    target: vi.fn(),
    updateFail: undefined as undefined | Error,
  };
});

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  activityInfo: () => ({ workflowExecution: h.als.getStore() }),
  asyncLocalStorage: { getStore: () => h.als.getStore() },
}));

/** Canonical form: key order is not significant, as with Postgres jsonb equality. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : 1
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

vi.mock('@auto-swe/shared/db', () => {
  return {
    prisma: {
      connection: { findUnique: h.connectionFind },
      pluginMcpMapping: { count: async () => 1, findMany: h.mappingFind },
      workflowRun: {
        findUnique: async () => {
          if (h.findFail) {
            throw h.findFail;
          }
          // The map is read now but handed over only once the gate opens: lets a test hold
          // several activities at their read, each holding the same (soon stale) map.
          const row = h.row.current ? structuredClone(h.row.current) : null;
          await h.findGate?.();
          return row;
        },
        updateMany: async ({
          data,
          where,
        }: {
          data: { harnessProfileVersions: unknown };
          where: { harnessProfileVersions: { equals: unknown }; id: string };
        }) => {
          if (h.updateFail) {
            throw h.updateFail;
          }
          const row = h.row.current;
          if (!row || row.id !== where.id) {
            return { count: 0 };
          }
          const expected = where.harnessProfileVersions.equals;
          const matches =
            expected === Prisma.DbNull
              ? row.harnessProfileVersions === null
              : canonical(row.harnessProfileVersions) === canonical(expected);
          if (!matches) {
            return { count: 0 };
          }
          row.harnessProfileVersions = structuredClone(data.harnessProfileVersions);
          return { count: 1 };
        },
      },
      workflowTemplate: { findUnique: vi.fn() },
    },
  };
});
vi.mock('./agentResolver.js', () => ({ resolveAgent: vi.fn() }));
vi.mock('./mcpConnection.js', () => ({ mcpUrlForConnection: h.target }));

import { readHarnessPinState } from './harnessProfile.js';
import { PLUGIN_MCP_SKIP, resolvePluginMcpBindings } from './pluginMcp.js';

const file = (path: string, content: unknown) => ({
  bytes: Buffer.from(JSON.stringify(content)),
  mode: '100644' as const,
  path,
});

/** A profile `kit` version `version` whose plugin `acme` declares HTTP servers `a` and `b`. */
const profile = (version = 3) =>
  ({
    commitSha: 'abc',
    contentHash: 'f'.repeat(64),
    files: [
      file('plugins/a/.claude-plugin/plugin.json', {
        mcpServers: {
          a: { type: 'http', url: 'https://a.example/' },
          b: { type: 'http', url: 'https://b.example/' },
        },
        name: 'acme',
      }),
    ],
    hooksEnabled: true,
    hooksLive: true,
    hooksPinned: true,
    manifest: {
      description: 'd',
      instructions: 'INSTRUCTIONS.md',
      name: 'kit',
      plugins: ['plugins/a'],
    },
    name: 'kit',
    version,
  }) as never;

const WF = 'wf-1';
const setRow = (map: unknown, temporalRunId: string | null = 'exec-1'): Row => {
  const row: Row = { harnessProfileVersions: map, id: 'run-1', temporalRunId, workflowId: WF };
  h.row.current = row;
  return row;
};
const stored = () => h.row.current?.harnessProfileVersions;

const MAPPED = [
  { connectionId: 'c1', serverName: 'a' },
  { connectionId: 'c2', serverName: 'b' },
];

/** One activity of `runId`: the resolver as `runtime.ts` calls it, inside that execution's context. */
async function activity(runId: string | undefined, version = 3) {
  const events: { name: string; outputJson: unknown }[] = [];
  const call = () =>
    resolvePluginMcpBindings({
      profiles: [profile(version)],
      tenant: { teamId: 'team-1' },
      toolKeys: null,
      tracer: { addActivityEvent: (e) => events.push(e as never) },
    });
  const out = await (runId ? h.als.run({ runId, workflowId: WF }, call) : call());
  return { events, ids: out.map((b) => b.connectionId).sort() };
}

const refusal = (reason: string) => [
  { name: 'agent.plugin_mcp_skipped', outputJson: { plugin: 'acme', reason, server: '*' } },
];

beforeEach(() => {
  h.row.current = null;
  h.findGate = undefined;
  h.findFail = undefined;
  h.updateFail = undefined;
  h.mappingFind.mockReset().mockResolvedValue(MAPPED);
  h.connectionFind.mockReset().mockResolvedValue({
    isActive: true,
    shares: [],
    teamId: 'team-1',
    type: 'mcp',
  });
  h.target.mockReset().mockImplementation(async (id: string) => ({ url: `https://t/${id}` }));
});

describe('the plugin MCP pin against the real pin store', () => {
  it('is unavailable with no run row, and outside an activity', async () => {
    const none = await activity('exec-1');
    expect(none.ids).toEqual([]);
    expect(none.events).toEqual(refusal(PLUGIN_MCP_SKIP.runNotPinnable));
    setRow({ kit: 3 });
    const outside = await activity(undefined);
    expect(outside.ids).toEqual([]);
    expect(outside.events).toEqual(refusal(PLUGIN_MCP_SKIP.runNotPinnable));
    expect(stored()).toEqual({ kit: 3 });
  });

  it('is unpinned when the run has no entry for the plugin', async () => {
    setRow({ other: 3 });
    const out = await activity('exec-1');
    expect(out.ids).toEqual([]);
    expect(out.events).toEqual(refusal(PLUGIN_MCP_SKIP.runNotPinnable));
    expect(stored()).toEqual({ other: 3 });
  });

  it('reports another execution’s map as foreign to a read-only caller, and the original execution never takes it', async () => {
    // exec-1 (the row's own) finds the map a later execution claimed.
    setRow({ __execution: 'exec-2', kit: { mcp: ['a=c1'], version: 3 } }, 'exec-1');
    expect(
      await h.als.run({ runId: 'exec-1', workflowId: WF }, () => readHarnessPinState('kit'))
    ).toMatchObject({ claimable: false, kind: 'foreign' });
    const out = await activity('exec-1');
    expect(out.ids).toEqual([]);
    expect(out.events).toEqual(refusal(PLUGIN_MCP_SKIP.pinForeign));
    expect(stored()).toEqual({ __execution: 'exec-2', kit: { mcp: ['a=c1'], version: 3 } });
  });

  it('claims a reused agent-run id: the first pin replaces the old map and relays', async () => {
    // An agent run takes no run-start stamp: the map is owned through the row's first execution.
    setRow({ kit: { mcp: ['x=c9'], verified: ['t:k:1'], version: 3 }, other: 7 }, 'exec-0');
    const out = await activity('exec-1');
    expect(out.ids).toEqual(['c1', 'c2']);
    expect(out.events).toEqual([]);
    expect(stored()).toEqual({
      __execution: 'exec-1',
      kit: { mcp: ['a=c1', 'b=c2'], version: 3 },
    });
    // The next activity of the same execution simply reads its own pin.
    expect((await activity('exec-1')).ids).toEqual(['c1', 'c2']);
  });

  it('writes the first pin from the live set at first use and relays what it reads back', async () => {
    setRow({ kit: 3 });
    const out = await activity('exec-1');
    expect(out.ids).toEqual(['c1', 'c2']);
    expect(stored()).toEqual({ kit: { mcp: ['a=c1', 'b=c2'], version: 3 } });
  });

  it('converges concurrent first uses on one pinned set', async () => {
    setRow({ kit: 3 });
    // Every activity reads the map before any of them writes.
    let waiting = 0;
    const open: (() => void)[] = [];
    h.findGate = () =>
      new Promise<void>((resolve) => {
        open.push(resolve);
        waiting += 1;
        if (waiting === 4) {
          for (const release of open.splice(0)) {
            release();
          }
          h.findGate = undefined;
        }
      });
    // Each sees a different live set when it first uses the plugin.
    let call = 0;
    h.mappingFind.mockImplementation(async () => {
      call += 1;
      return call % 2 ? [MAPPED[0]] : MAPPED;
    });
    const results = await Promise.all([
      activity('exec-1'),
      activity('exec-1'),
      activity('exec-1'),
      activity('exec-1'),
    ]);
    const pin = (stored() as { kit: { mcp: string[] } }).kit.mcp;
    expect([['a=c1'], ['a=c1', 'b=c2']]).toContainEqual(pin);
    const pinnedIds = new Set(pin.map((p) => p.split('=')[1]));
    for (const { ids } of results) {
      // Whatever an activity saw live, it relays only what the one stored pin holds.
      expect(ids.every((id) => pinnedIds.has(id))).toBe(true);
      expect(ids.length).toBeGreaterThan(0);
    }
  });

  it('converges concurrent claims of a reused id on one map', async () => {
    setRow({ kit: { mcp: ['x=c9'], version: 3 } }, 'exec-0');
    let waiting = 0;
    const open: (() => void)[] = [];
    h.findGate = () =>
      new Promise<void>((resolve) => {
        open.push(resolve);
        waiting += 1;
        if (waiting === 3) {
          for (const release of open.splice(0)) {
            release();
          }
          h.findGate = undefined;
        }
      });
    const results = await Promise.all([activity('exec-1'), activity('exec-1'), activity('exec-1')]);
    expect(stored()).toEqual({
      __execution: 'exec-1',
      kit: { mcp: ['a=c1', 'b=c2'], version: 3 },
    });
    expect(results.map((r) => r.ids)).toEqual([
      ['c1', 'c2'],
      ['c1', 'c2'],
      ['c1', 'c2'],
    ]);
  });

  it('lets a still-running old execution neither claim nor overwrite the new owner’s map', async () => {
    setRow({ kit: 3 }, 'exec-0');
    // The old execution reads the unclaimed map while the new one claims it.
    let opened = false;
    h.findGate = async () => {
      if (!opened) {
        opened = true;
        await h.als.run({ runId: 'exec-1', workflowId: WF }, () => activity('exec-1'));
      }
    };
    const old = await activity('exec-0');
    h.findGate = undefined;
    expect(old.ids).toEqual([]);
    expect(stored()).toEqual({
      __execution: 'exec-1',
      kit: { mcp: ['a=c1', 'b=c2'], version: 3 },
    });
  });

  it('reports a database error on read as unreadable, reading no connection', async () => {
    setRow({ kit: 3 });
    h.findFail = new Error('db down');
    const out = await activity('exec-1');
    expect(out.ids).toEqual([]);
    expect(out.events).toEqual(refusal(PLUGIN_MCP_SKIP.pinUnreadable));
    expect(h.connectionFind).not.toHaveBeenCalled();
  });

  it('reports a database error on write as unwritable, reading no connection', async () => {
    setRow({ kit: 3 });
    h.updateFail = new Error('write failed');
    const out = await activity('exec-1');
    expect(out.ids).toEqual([]);
    expect(out.events).toEqual(refusal(PLUGIN_MCP_SKIP.pinUnwritable));
    expect(h.connectionFind).not.toHaveBeenCalled();
    expect(stored()).toEqual({ kit: 3 });
  });

  it('never relays a mapping added after an empty pin, and says so', async () => {
    setRow({ kit: { mcp: [], version: 3 } });
    const out = await activity('exec-1');
    expect(out.ids).toEqual([]);
    expect(out.events.map((e) => e.outputJson)).toEqual([
      { plugin: 'acme', reason: PLUGIN_MCP_SKIP.mappedAfterPin, server: 'a' },
      { plugin: 'acme', reason: PLUGIN_MCP_SKIP.mappedAfterPin, server: 'b' },
    ]);
    expect(stored()).toEqual({ kit: { mcp: [], version: 3 } });
    expect(h.connectionFind).not.toHaveBeenCalled();
  });

  it('reads a damaged list as empty, says it is damaged, and rewrites nothing', async () => {
    setRow({ kit: { mcp: ['not-a-pair'], version: 3 } });
    const out = await activity('exec-1');
    expect(out.ids).toEqual([]);
    expect(out.events).toEqual(refusal(PLUGIN_MCP_SKIP.pinDamaged));
    expect(stored()).toEqual({ kit: { mcp: ['not-a-pair'], version: 3 } });
  });

  describe('a mutation test by construction: no refusal falls back to the live set', () => {
    // Each case is a way the run cannot establish a pin. With the live mappings present and
    // usable, a fallback to them would relay c1 and c2 and read their connections.
    const cases: [string, () => void | Promise<void>, string, string | undefined][] = [
      ['no run row', () => undefined, PLUGIN_MCP_SKIP.runNotPinnable, 'exec-1'],
      [
        'outside an activity',
        () => void setRow({ kit: 3 }),
        PLUGIN_MCP_SKIP.runNotPinnable,
        undefined,
      ],
      ['no entry', () => void setRow({}), PLUGIN_MCP_SKIP.runNotPinnable, 'exec-1'],
      [
        'the run row’s own execution against a later one’s map',
        () => void setRow({ __execution: 'exec-2', kit: { mcp: ['a=c1'], version: 3 } }),
        PLUGIN_MCP_SKIP.pinForeign,
        'exec-1',
      ],
      [
        'a different version',
        () => void setRow({ kit: { mcp: ['a=c1', 'b=c2'], version: 2 } }),
        PLUGIN_MCP_SKIP.pinVersionDiffers,
        'exec-1',
      ],
      [
        'an unreadable pin',
        () => {
          setRow({ kit: 3 });
          h.findFail = new Error('db');
        },
        PLUGIN_MCP_SKIP.pinUnreadable,
        'exec-1',
      ],
      [
        'an unwritable first pin',
        () => {
          setRow({ kit: 3 });
          h.updateFail = new Error('db');
        },
        PLUGIN_MCP_SKIP.pinUnwritable,
        'exec-1',
      ],
    ];
    it.each(cases)(
      'relays nothing and reads no connection: %s',
      async (_label, arrange, reason, exec) => {
        await arrange();
        const out = await activity(exec);
        expect(out.ids).toEqual([]);
        expect(out.events).toEqual(refusal(reason));
        expect(h.connectionFind).not.toHaveBeenCalled();
        expect(h.target).not.toHaveBeenCalled();
      }
    );
  });
});
