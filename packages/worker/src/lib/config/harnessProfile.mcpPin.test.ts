import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  mappingCount: vi.fn(),
  resolveAgent: vi.fn(),
  runFind: vi.fn(),
  runUpdateMany: vi.fn(),
}));

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  activityInfo: () => ({ workflowExecution: { runId: 'exec-1', workflowId: 'wf-1' } }),
  asyncLocalStorage: { getStore: () => ({}) },
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    harnessProfile: { findUnique: vi.fn() },
    harnessProfileVersion: { findUnique: vi.fn() },
    pluginEnablement: { findMany: vi.fn() },
    pluginMcpMapping: { count: h.mappingCount },
    workflowRun: { findUnique: h.runFind, updateMany: h.runUpdateMany },
  },
}));
vi.mock('./agentResolver.js', () => ({ resolveAgent: h.resolveAgent }));

import { Prisma } from '@auto-swe/shared';
import {
  pinHarnessProfile,
  readHarnessPin,
  readHarnessPinState,
  resolveProfileForRuntime,
} from './harnessProfile.js';
import { parsePinEntry } from './pluginEnablement.js';

/** A run row whose pin map the compare-and-set reads and writes. */
function runRow(initial: Record<string, unknown> | null, temporalRunId: string | null = 'exec-1') {
  const row = { harnessProfileVersions: initial, id: 'run-1', temporalRunId };
  h.runFind.mockImplementation(async () => ({ ...row }));
  h.runUpdateMany.mockImplementation(
    async ({
      data,
      where,
    }: {
      data: { harnessProfileVersions: unknown };
      where: { harnessProfileVersions: unknown };
    }) => {
      const expected = row.harnessProfileVersions
        ? { equals: row.harnessProfileVersions }
        : { equals: Prisma.DbNull };
      if (JSON.stringify(where.harnessProfileVersions) !== JSON.stringify(expected)) {
        return { count: 0 };
      }
      row.harnessProfileVersions = data.harnessProfileVersions as Record<string, unknown>;
      return { count: 1 };
    }
  );
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the plugin pin entry', () => {
  it('reads the mapped connection set, and reads an old entry without one as unpinned', () => {
    expect(parsePinEntry({ mcp: ['b=c2', 'a=c1'], version: 2 })).toEqual({
      mcp: ['b=c2', 'a=c1'],
      verified: new Set(),
      version: 2,
    });
    expect(parsePinEntry({ hooks: true, version: 2 })?.mcp).toBeUndefined();
    expect(parsePinEntry(2)?.mcp).toBeUndefined();
  });

  it('reads a damaged set as an empty one, never as an unpinned one', () => {
    expect(parsePinEntry({ mcp: 'oops', version: 2 })?.mcp).toEqual([]);
    expect(parsePinEntry({ mcp: ['a=c1', 7, null], version: 2 })?.mcp).toEqual([]);
    // A bare connection id (no `<name>=<id>` shape) is not an upgrade path: it reads as empty.
    expect(parsePinEntry({ mcp: ['c1', 'c2'], version: 2 })?.mcp).toEqual([]);
    expect(parsePinEntry({ mcp: ['a=c1', 'c2'], version: 2 })?.mcp).toEqual([]);
    expect(parsePinEntry({ mcp: ['=c1'], version: 2 })?.mcp).toEqual([]);
  });
});

describe('pinHarnessProfile with a connection set', () => {
  it('records the sorted set beside the version, hooks and verified bindings', async () => {
    const row = runRow({ kit: { hooks: false, verified: ['t:a:1'], version: 4 } });
    const pinned = await pinHarnessProfile('wf-1', 'kit', 4, {
      mcpPins: ['c2', 'c1', 'c2'],
      runId: 'exec-1',
    });
    expect(pinned).toEqual({ hooks: false, mcp: ['c1', 'c2'], version: 4 });
    expect(row.harnessProfileVersions).toEqual({
      kit: { hooks: false, mcp: ['c1', 'c2'], verified: ['t:a:1'], version: 4 },
    });
  });

  it('never overwrites a set the run already pinned: the first use decides', async () => {
    const row = runRow({ kit: { mcp: ['a=c1'], version: 4 } });
    const pinned = await pinHarnessProfile('wf-1', 'kit', 4, {
      mcpPins: ['a=c1', 'b=c9'],
      runId: 'exec-1',
    });
    expect(pinned.mcp).toEqual(['a=c1']);
    expect(h.runUpdateMany).not.toHaveBeenCalled();
    expect(row.harnessProfileVersions).toEqual({ kit: { mcp: ['a=c1'], version: 4 } });
  });

  it('upgrades an entry written before the set existed, keeping its version', async () => {
    const row = runRow({ kit: 3 });
    const pinned = await pinHarnessProfile('wf-1', 'kit', 9, {
      mcpPins: [],
      runId: 'exec-1',
    });
    expect(pinned).toEqual({ hooks: undefined, mcp: [], version: 3 });
    expect(row.harnessProfileVersions).toEqual({ kit: { mcp: [], version: 3 } });
  });

  it('never replaces an id-only (damaged) set: it stays empty', async () => {
    const row = runRow({ kit: { mcp: ['c1', 'c2'], version: 4 } });
    const pinned = await pinHarnessProfile('wf-1', 'kit', 4, {
      mcpPins: ['a=c1'],
      runId: 'exec-1',
    });
    expect(pinned.mcp).toEqual([]);
    expect(h.runUpdateMany).not.toHaveBeenCalled();
    expect(row.harnessProfileVersions).toEqual({ kit: { mcp: ['c1', 'c2'], version: 4 } });
  });

  it('pins nothing for a pin another execution took', async () => {
    const row = runRow({ kit: 3 }, 'exec-OTHER');
    await pinHarnessProfile('wf-1', 'kit', 3, { mcpPins: ['c1'], runId: 'exec-1' });
    expect(h.runUpdateMany).not.toHaveBeenCalled();
    expect(row.harnessProfileVersions).toEqual({ kit: 3 });
  });

  it('leaves every existing call untouched: without a set the entry has none', async () => {
    const row = runRow(null);
    await pinHarnessProfile('wf-1', 'kit', 2, { hooksEnabled: true, runId: 'exec-1' });
    expect(row.harnessProfileVersions).toEqual({ kit: { hooks: true, version: 2 } });
  });
});

describe('readHarnessPin', () => {
  it('returns the entry of the current execution, and nothing for another’s', async () => {
    runRow({ kit: { mcp: ['a=c1'], version: 4 } });
    expect(await readHarnessPin('kit')).toMatchObject({
      pin: { mcp: ['a=c1'], version: 4 },
      runId: 'exec-1',
      workflowId: 'wf-1',
    });
    expect(await readHarnessPin('other')).toBeUndefined();
    runRow({ kit: 4 }, 'exec-OTHER');
    expect(await readHarnessPin('kit')).toBeUndefined();
  });
});

describe('readHarnessPinState', () => {
  it('tells an entry, no entry, and another execution’s pin apart', async () => {
    runRow({ kit: { mcp: ['a=c1'], version: 4 } });
    expect(await readHarnessPinState('kit')).toMatchObject({
      kind: 'pinned',
      pin: { mcp: ['a=c1'], version: 4 },
    });
    expect(await readHarnessPinState('other')).toEqual({ kind: 'unpinned' });
    runRow({ kit: 4 }, 'exec-OTHER');
    expect(await readHarnessPinState('kit')).toEqual({
      claimable: true,
      kind: 'foreign',
      runId: 'exec-1',
      workflowId: 'wf-1',
    });
    // The execution the row was created for is the stale side of a later execution's map.
    runRow({ __execution: 'exec-9', kit: 4 }, 'exec-1');
    expect(await readHarnessPinState('kit')).toMatchObject({ claimable: false, kind: 'foreign' });
  });
});

describe('pinHarnessProfile claim', () => {
  it('replaces another execution’s map with the current one’s own, dropping every old entry', async () => {
    const row = runRow(
      {
        kit: { hooks: false, mcp: ['a=c1'], verified: ['t:k:1'], version: 2 },
        other: 5,
      },
      'exec-0'
    );
    const out = await pinHarnessProfile('wf-1', 'kit', 3, {
      claim: true,
      hooksEnabled: true,
      mcpPins: ['b=c2'],
      runId: 'exec-1',
    });
    expect(out).toEqual({ hooks: true, mcp: ['b=c2'], version: 3 });
    expect(row.harnessProfileVersions).toEqual({
      __execution: 'exec-1',
      kit: { hooks: true, mcp: ['b=c2'], version: 3 },
    });
  });

  it('claims a map stamped for another execution the same way', async () => {
    const row = runRow({ __execution: 'exec-0', kit: { mcp: ['a=c1'], version: 2 } }, 'exec-0');
    await pinHarnessProfile('wf-1', 'kit', 3, { claim: true, mcpPins: [], runId: 'exec-1' });
    expect(row.harnessProfileVersions).toEqual({
      __execution: 'exec-1',
      kit: { mcp: [], version: 3 },
    });
  });

  it('claims a row with no map at all when the row names another execution', async () => {
    const row = runRow(null, 'exec-0');
    await pinHarnessProfile('wf-1', 'kit', 3, { claim: true, runId: 'exec-1' });
    expect(row.harnessProfileVersions).toEqual({ __execution: 'exec-1', kit: 3 });
  });

  it('never claims without being asked, nor as the execution the row was created for', async () => {
    const a = runRow({ __execution: 'exec-9', kit: 2 }, 'exec-1');
    await pinHarnessProfile('wf-1', 'kit', 3, { claim: true, mcpPins: [], runId: 'exec-1' });
    expect(a.harnessProfileVersions).toEqual({ __execution: 'exec-9', kit: 2 });
    const b = runRow({ kit: 2 }, 'exec-0');
    await pinHarnessProfile('wf-1', 'kit', 3, { mcpPins: [], runId: 'exec-1' });
    expect(b.harnessProfileVersions).toEqual({ kit: 2 });
  });

  it('converges concurrent claims on one winner, the loser keeping the winner’s entry', async () => {
    const row = runRow({ kit: 2 }, 'exec-0');
    const [x, y] = await Promise.all([
      pinHarnessProfile('wf-1', 'kit', 3, { claim: true, mcpPins: ['x=c1'], runId: 'exec-1' }),
      pinHarnessProfile('wf-1', 'kit', 4, { claim: true, mcpPins: ['y=c2'], runId: 'exec-1' }),
    ]);
    expect(x).toEqual(y);
    expect(row.harnessProfileVersions).toEqual({
      __execution: 'exec-1',
      kit: { mcp: x.mcp, version: x.version },
    });
  });

  it('keeps a still-running old execution from overwriting the new owner’s map (compare-and-set on the map it read)', async () => {
    const row = runRow({ kit: 2 }, 'exec-0');
    const claimed = { __execution: 'exec-1', kit: { mcp: ['n=c9'], version: 3 } };
    // exec-1 claims between the old execution's read and its write.
    h.runFind.mockImplementationOnce(async () => {
      const seen = { ...row };
      row.harnessProfileVersions = claimed;
      return seen;
    });
    const out = await pinHarnessProfile('wf-1', 'kit', 2, {
      claim: true,
      mcpPins: ['old=c0'],
      runId: 'exec-0',
    });
    // Its write named the stale map and lost; the retry sees another owner and, being the
    // execution the row was created for, does not claim.
    expect(h.runUpdateMany.mock.calls[0]?.[0].where.harnessProfileVersions).toEqual({
      equals: { kit: 2 },
    });
    expect(row.harnessProfileVersions).toEqual(claimed);
    expect(out.mcp).toEqual(['old=c0']);
  });
});

describe('plugins on a runtime that cannot relay their MCP servers', () => {
  const run = async (mapped: number | Error) => {
    if (mapped instanceof Error) {
      h.mappingCount.mockRejectedValue(mapped);
    } else {
      h.mappingCount.mockResolvedValue(mapped);
    }
    const events: { name: string; outputJson: { skipped?: string[] } }[] = [];
    await resolveProfileForRuntime({
      agentKey: 'implementer',
      ctx: undefined,
      resolved: { harnessProfiles: ['kit'], scope: 'GLOBAL', teamId: null, version: 1 },
      runtime: 'mastra',
      tracer: { addActivityEvent: (e) => events.push(e as never) },
    });
    return events.find((e) => e.name === 'agent.plugin_partial')?.outputJson.skipped;
  };

  it('names mcp among what was skipped only when a server is mapped', async () => {
    expect(await run(2)).toEqual(['commands', 'hooks', 'sub-agents', 'mcp']);
    expect(await run(0)).toEqual(['commands', 'hooks', 'sub-agents']);
  });

  it('keeps the event, without mcp, when the mappings cannot be read', async () => {
    expect(await run(new Error('db down'))).toEqual(['commands', 'hooks', 'sub-agents']);
  });
});
