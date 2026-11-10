import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  inActivity: { value: true },
  profileFind: vi.fn(),
  resolveAgent: vi.fn(),
  runFind: vi.fn(),
  runUpdateMany: vi.fn(),
  versionFind: vi.fn(),
}));

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  activityInfo: () => ({ workflowExecution: { workflowId: 'wf-1' } }),
  asyncLocalStorage: { getStore: () => (h.inActivity.value ? {} : undefined) },
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    harnessProfile: { findUnique: h.profileFind },
    harnessProfileVersion: { findUnique: h.versionFind },
    workflowRun: { findUnique: h.runFind, updateMany: h.runUpdateMany },
  },
}));
vi.mock('./agentResolver.js', () => ({ resolveAgent: h.resolveAgent }));

import { Prisma } from '@auto-swe/shared';
import { computeContentHash, packFiles } from '@auto-swe/shared/lib/harnessProfile';
import {
  pinHarnessProfileVersion,
  resolveHarnessProfile,
  resolveProfileForRuntime,
} from './harnessProfile.js';

const file = (path: string, text: string) => ({
  bytes: Buffer.from(text),
  mode: '100644' as const,
  path,
});
const manifestFile = (over: Record<string, unknown> = {}) =>
  file('profile.json', JSON.stringify({ description: 'A profile', name: 'kit', ...over }));

const MANIFEST = { description: 'A profile', instructions: 'INSTRUCTIONS.md', name: 'kit' };

/** A stored version row for `text` as the INSTRUCTIONS body; `tamper` breaks the hash. */
function versionRow(text: string, tamper = false) {
  const files = [manifestFile({ name: 'kit' }), file('INSTRUCTIONS.md', text)];
  const hash = computeContentHash(files, MANIFEST);
  return {
    commitSha: 'abc',
    contentHash: tamper ? 'f'.repeat(64) : hash,
    files: packFiles(files),
    manifest: MANIFEST,
  };
}

/** A run row whose pin map the updateMany compare-and-set reads and writes. */
function runRow(initial: Record<string, unknown> | null) {
  const row = { harnessProfileVersions: initial, id: 'run-1' };
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

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  latestVersion: 2,
  status: 'OK',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.inActivity.value = true;
  h.resolveAgent.mockResolvedValue({ harnessProfile: 'kit' });
  h.profileFind.mockResolvedValue(profile());
  h.versionFind.mockImplementation(async ({ where }) =>
    versionRow(`version ${where.profileId_version.version}`)
  );
});

describe('resolveHarnessProfile', () => {
  it('returns null, and touches nothing, for an agent bound to no profile', async () => {
    h.resolveAgent.mockResolvedValue({ harnessProfile: null });
    expect(await resolveHarnessProfile('implementer', undefined)).toBeNull();
    expect(h.profileFind).not.toHaveBeenCalled();
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });

  it('takes the profile name from the caller’s own resolution, not a second one', async () => {
    runRow(null);
    h.resolveAgent.mockResolvedValue({ harnessProfile: 'a-version-cut-in-between' });
    const r = await resolveHarnessProfile('implementer', {}, { harnessProfile: 'kit' });
    expect(r).toMatchObject({ name: 'kit' });
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(h.profileFind).toHaveBeenCalledWith(expect.objectContaining({ where: { name: 'kit' } }));
    expect(
      await resolveProfileForRuntime({
        agentKey: 'implementer',
        ctx: {},
        resolved: { harnessProfile: null },
        runtime: 'claude-code',
        tracer: { addActivityEvent: vi.fn() },
      })
    ).toBeUndefined();
    expect(h.resolveAgent).not.toHaveBeenCalled();
  });

  it('uses the latest version, verified, and pins it on the run', async () => {
    const row = runRow(null);
    const r = await resolveHarnessProfile('implementer', {});
    expect(r).toMatchObject({ commitSha: 'abc', name: 'kit', version: 2 });
    expect(r?.files.map((f) => f.path)).toEqual(['INSTRUCTIONS.md', 'profile.json']);
    expect(r?.files.find((f) => f.path === 'INSTRUCTIONS.md')?.bytes.toString()).toBe('version 2');
    expect(row.harnessProfileVersions).toEqual({ kit: 2 });
  });

  it('keeps the run’s pinned version after a newer one is approved', async () => {
    runRow({ kit: 1 });
    const r = await resolveHarnessProfile('implementer', {});
    expect(r?.version).toBe(1);
    expect(r?.files.find((f) => f.path === 'INSTRUCTIONS.md')?.bytes.toString()).toBe('version 1');
  });

  it('prefers a caller-supplied pin over the run’s, and never writes it back', async () => {
    const row = runRow({ kit: 1 });
    const r = await resolveHarnessProfile('implementer', { harnessProfileVersions: { kit: 2 } });
    expect(r?.version).toBe(2);
    expect(row.harnessProfileVersions).toEqual({ kit: 1 });
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });

  it('resolves live and pins nothing outside an activity', async () => {
    h.inActivity.value = false;
    const r = await resolveHarnessProfile('implementer', {});
    expect(r?.version).toBe(2);
    expect(h.runFind).not.toHaveBeenCalled();
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });

  it('fails closed when the profile is disabled and the run has not pinned it', async () => {
    runRow(null);
    h.profileFind.mockResolvedValue(profile({ status: 'DISABLED' }));
    await expect(resolveHarnessProfile('implementer', {})).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_UNAVAILABLE',
    });
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });

  it('still serves a disabled profile to a run that pinned it', async () => {
    runRow({ kit: 1 });
    h.profileFind.mockResolvedValue(profile({ status: 'DISABLED' }));
    expect((await resolveHarnessProfile('implementer', {}))?.version).toBe(1);
  });

  it('fails closed when the profile does not exist, even if pinned', async () => {
    runRow({ kit: 1 });
    h.profileFind.mockResolvedValue(null);
    await expect(resolveHarnessProfile('implementer', {})).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_UNAVAILABLE',
    });
  });

  it('fails closed when the pinned version row is gone', async () => {
    runRow({ kit: 7 });
    h.versionFind.mockResolvedValue(null);
    await expect(resolveHarnessProfile('implementer', {})).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_UNAVAILABLE',
    });
  });

  it('fails closed with PROFILE_INTEGRITY when the snapshot no longer matches its hash', async () => {
    runRow({ kit: 1 });
    h.versionFind.mockResolvedValue(versionRow('x', true));
    await expect(resolveHarnessProfile('implementer', {})).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_INTEGRITY',
    });
  });

  it('fails closed with PROFILE_INTEGRITY on a malformed stored manifest', async () => {
    runRow({ kit: 1 });
    h.versionFind.mockResolvedValue({ ...versionRow('x'), manifest: { nope: true } });
    await expect(resolveHarnessProfile('implementer', {})).rejects.toMatchObject({
      type: 'PROFILE_INTEGRITY',
    });
  });

  it('does not use a profile bound to a different agent (no inheritance)', async () => {
    // The resolver returns the version’s OWN binding; a persona with none gets none.
    h.resolveAgent.mockResolvedValue({ harnessProfile: null, runtime: 'claude-code' });
    expect(await resolveHarnessProfile('ciFixer', {})).toBeNull();
  });

  it('adopts the version a concurrent resolution pinned first', async () => {
    const row = runRow(null);
    const cas = h.runUpdateMany.getMockImplementation();
    // Another activity pins version 1 between our read and our write.
    h.runUpdateMany.mockImplementationOnce(async () => {
      row.harnessProfileVersions = { kit: 1 };
      return { count: 0 };
    });
    expect(cas).toBeDefined();
    const r = await resolveHarnessProfile('implementer', {});
    expect(r?.version).toBe(1);
    expect(row.harnessProfileVersions).toEqual({ kit: 1 });
  });
});

describe('pinHarnessProfileVersion', () => {
  it('keeps both entries when two profiles pin at once, and never overwrites a pin', async () => {
    const row = runRow(null);
    const [a, b] = await Promise.all([
      pinHarnessProfileVersion('wf-1', 'kit', 2),
      pinHarnessProfileVersion('wf-1', 'other', 5),
    ]);
    expect([a, b]).toEqual([2, 5]);
    expect(row.harnessProfileVersions).toEqual({ kit: 2, other: 5 });
    expect(await pinHarnessProfileVersion('wf-1', 'kit', 9)).toBe(2);
    expect(row.harnessProfileVersions).toEqual({ kit: 2, other: 5 });
  });

  it('two pins of the same profile agree on the first', async () => {
    runRow(null);
    const [a, b] = await Promise.all([
      pinHarnessProfileVersion('wf-1', 'kit', 1),
      pinHarnessProfileVersion('wf-1', 'kit', 2),
    ]);
    expect(a).toBe(b);
  });

  it('keeps the candidate for a workflow with no run row', async () => {
    h.runFind.mockResolvedValue(null);
    expect(await pinHarnessProfileVersion('wf-x', 'kit', 3)).toBe(3);
  });

  it('throws a retryable error when the map keeps changing', async () => {
    runRow(null);
    h.runUpdateMany.mockResolvedValue({ count: 0 });
    await expect(pinHarnessProfileVersion('wf-1', 'kit', 1)).rejects.toThrow(/could not pin/);
  });
});

describe('resolveProfileForRuntime', () => {
  const tracer = () => ({ addActivityEvent: vi.fn() });
  const args = (over: Record<string, unknown> = {}) => ({
    agentKey: 'implementer',
    ctx: undefined,
    runtime: 'claude-code',
    tracer: tracer(),
    ...over,
  });

  it('returns the verified snapshot for the Claude Code runtime', async () => {
    runRow(null);
    const given = args();
    const resolved = await resolveProfileForRuntime(given);
    expect(resolved).toMatchObject({ name: 'kit', version: 2 });
    expect(given.tracer.addActivityEvent).not.toHaveBeenCalled();
  });

  it('returns undefined, with no event, for an agent bound to no profile', async () => {
    h.resolveAgent.mockResolvedValue({ harnessProfile: null });
    const given = args();
    await expect(resolveProfileForRuntime(given)).resolves.toBeUndefined();
    expect(given.tracer.addActivityEvent).not.toHaveBeenCalled();
  });

  it.each(['mastra', 'pi'])('runs a %s agent without its profile and says so', async (runtime) => {
    const given = args({ runtime });
    await expect(resolveProfileForRuntime(given)).resolves.toBeUndefined();
    expect(h.profileFind).not.toHaveBeenCalled();
    expect(given.tracer.addActivityEvent).toHaveBeenCalledWith({
      name: 'agent.profile_not_applicable',
      outputJson: { agentKey: 'implementer', profile: 'kit', ranOn: runtime, runtime },
    });
  });

  it('does not load a profile on a surface with no workspace, whatever the runtime', async () => {
    const given = args({ appliesToRun: false, ranOn: 'mastra' });
    await expect(resolveProfileForRuntime(given)).resolves.toBeUndefined();
    expect(h.profileFind).not.toHaveBeenCalled();
    expect(given.tracer.addActivityEvent).toHaveBeenCalledWith({
      name: 'agent.profile_not_applicable',
      outputJson: {
        agentKey: 'implementer',
        profile: 'kit',
        ranOn: 'mastra',
        runtime: 'claude-code',
      },
    });
  });

  it('lets a missing or tampered profile fail the Claude Code run, untouched', async () => {
    h.profileFind.mockResolvedValue(null);
    await expect(resolveProfileForRuntime(args())).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_UNAVAILABLE',
    });
    h.profileFind.mockResolvedValue(profile());
    runRow({ kit: 1 });
    h.versionFind.mockResolvedValue(versionRow('x', true));
    await expect(resolveProfileForRuntime(args())).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_INTEGRITY',
    });
  });
});
