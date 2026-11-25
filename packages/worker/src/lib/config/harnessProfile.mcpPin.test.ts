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
import { pinHarnessProfile, readHarnessPin, resolveProfileForRuntime } from './harnessProfile.js';
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
