import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabledFind: vi.fn(),
  inActivity: { value: true },
  profileFind: vi.fn(),
  resolveAgent: vi.fn(),
  runFind: vi.fn(),
  runUpdateMany: vi.fn(),
  versionFind: vi.fn(),
}));

vi.mock('@temporalio/activity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@temporalio/activity')>()),
  activityInfo: () => ({ workflowExecution: { runId: 'exec-1', workflowId: 'wf-1' } }),
  asyncLocalStorage: { getStore: () => (h.inActivity.value ? {} : undefined) },
}));
vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    harnessProfile: { findUnique: h.profileFind },
    harnessProfileVersion: { findUnique: h.versionFind },
    pluginEnablement: { findMany: h.enabledFind },
    workflowRun: { findUnique: h.runFind, updateMany: h.runUpdateMany },
  },
}));
vi.mock('./agentResolver.js', () => ({ resolveAgent: h.resolveAgent }));

import { Prisma } from '@auto-swe/shared';
import { computeContentHash, packFiles } from '@auto-swe/shared/lib/harnessProfile';
import {
  type ProfileBinding,
  pinHarnessProfileVersion,
  resolveHarnessProfiles,
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

const binding = (
  harnessProfiles: string[],
  over: Partial<ProfileBinding> = {}
): ProfileBinding => ({
  harnessProfiles,
  scope: 'GLOBAL',
  teamId: null,
  version: 4,
  ...over,
});

const profile = (over: Record<string, unknown> = {}) => ({
  hooksEnabled: true,
  id: 'p1',
  latestVersion: 2,
  status: 'OK',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.inActivity.value = true;
  h.resolveAgent.mockResolvedValue(binding(['kit']));
  h.enabledFind.mockResolvedValue([]);
  h.profileFind.mockResolvedValue(profile());
  h.versionFind.mockImplementation(async ({ where }) =>
    versionRow(`version ${where.profileId_version.version}`)
  );
});

describe('resolveHarnessProfiles', () => {
  it('returns an empty list, and touches nothing, for an agent bound to no profile', async () => {
    h.resolveAgent.mockResolvedValue(binding([]));
    expect(await resolveHarnessProfiles('implementer', undefined)).toEqual([]);
    expect(h.profileFind).not.toHaveBeenCalled();
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });

  it('takes the profile name from the caller’s own resolution, not a second one', async () => {
    runRow(null);
    h.resolveAgent.mockResolvedValue(binding(['a-version-cut-in-between']));
    const r = await resolveHarnessProfiles('implementer', {}, binding(['kit']));
    expect(r[0]).toMatchObject({ name: 'kit' });
    expect(h.resolveAgent).not.toHaveBeenCalled();
    expect(h.profileFind).toHaveBeenCalledWith(expect.objectContaining({ where: { name: 'kit' } }));
    expect(
      await resolveProfileForRuntime({
        agentKey: 'implementer',
        ctx: {},
        resolved: binding([]),
        runtime: 'claude-code',
        tracer: { addActivityEvent: vi.fn() },
      })
    ).toBeUndefined();
    expect(h.resolveAgent).not.toHaveBeenCalled();
  });

  it('uses the latest version, verified, and pins it on the run', async () => {
    const row = runRow(null);
    const [r] = await resolveHarnessProfiles('implementer', {});
    expect(r).toMatchObject({ commitSha: 'abc', hooksEnabled: true, name: 'kit', version: 2 });
    expect(r?.files.map((f: { path: string }) => f.path)).toEqual([
      'INSTRUCTIONS.md',
      'profile.json',
    ]);
    expect(
      r?.files.find((f: { path: string }) => f.path === 'INSTRUCTIONS.md')?.bytes.toString()
    ).toBe('version 2');
    expect(row.harnessProfileVersions).toEqual({ kit: { hooks: true, version: 2 } });
  });

  it('keeps the run’s pinned version after a newer one is approved', async () => {
    runRow({ kit: 1 });
    const [r] = await resolveHarnessProfiles('implementer', {});
    expect(r?.version).toBe(1);
    expect(
      r?.files.find((f: { path: string }) => f.path === 'INSTRUCTIONS.md')?.bytes.toString()
    ).toBe('version 1');
  });

  it('prefers a caller-supplied pin over the run’s, and never writes it back', async () => {
    const row = runRow({ kit: 1 });
    const [r] = await resolveHarnessProfiles('implementer', {
      harnessProfileVersions: { kit: 2 },
    });
    expect(r?.version).toBe(2);
    expect(row.harnessProfileVersions).toEqual({ kit: 1 });
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });

  it('resolves live and pins nothing outside an activity', async () => {
    h.inActivity.value = false;
    const [r] = await resolveHarnessProfiles('implementer', {});
    expect(r?.version).toBe(2);
    expect(h.runFind).not.toHaveBeenCalled();
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });

  it('fails closed when the profile is disabled and the run has not pinned it', async () => {
    runRow(null);
    h.profileFind.mockResolvedValue(profile({ status: 'DISABLED' }));
    await expect(resolveHarnessProfiles('implementer', {})).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_UNAVAILABLE',
    });
    expect(h.runUpdateMany).not.toHaveBeenCalled();
  });

  it('still serves a disabled profile to a run that pinned it', async () => {
    runRow({ kit: 1 });
    h.profileFind.mockResolvedValue(profile({ status: 'DISABLED' }));
    expect((await resolveHarnessProfiles('implementer', {}))[0]?.version).toBe(1);
  });

  it('fails closed when the profile does not exist, even if pinned', async () => {
    runRow({ kit: 1 });
    h.profileFind.mockResolvedValue(null);
    await expect(resolveHarnessProfiles('implementer', {})).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_UNAVAILABLE',
    });
  });

  it('fails closed when the pinned version row is gone', async () => {
    runRow({ kit: 7 });
    h.versionFind.mockResolvedValue(null);
    await expect(resolveHarnessProfiles('implementer', {})).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_UNAVAILABLE',
    });
  });

  it('fails closed with PROFILE_INTEGRITY when the snapshot no longer matches its hash', async () => {
    runRow({ kit: 1 });
    h.versionFind.mockResolvedValue(versionRow('x', true));
    await expect(resolveHarnessProfiles('implementer', {})).rejects.toMatchObject({
      nonRetryable: true,
      type: 'PROFILE_INTEGRITY',
    });
  });

  it('fails closed with PROFILE_INTEGRITY on a malformed stored manifest', async () => {
    runRow({ kit: 1 });
    h.versionFind.mockResolvedValue({ ...versionRow('x'), manifest: { nope: true } });
    await expect(resolveHarnessProfiles('implementer', {})).rejects.toMatchObject({
      type: 'PROFILE_INTEGRITY',
    });
  });

  it('does not use a profile bound to a different agent (no inheritance)', async () => {
    // The resolver returns the version’s OWN binding; a persona with none gets none.
    h.resolveAgent.mockResolvedValue({ ...binding([]), runtime: 'claude-code' });
    expect(await resolveHarnessProfiles('ciFixer', {})).toEqual([]);
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
    const [r] = await resolveHarnessProfiles('implementer', {});
    expect(r?.version).toBe(1);
    // The pin it found had no hook switch; the first use records it beside the version.
    expect(row.harnessProfileVersions).toEqual({ kit: { hooks: true, version: 1 } });
  });
});

describe('several plugins, hooks, enablement and collisions', () => {
  /** A stored version row for a one-plugin profile whose plugin.json is named `plugin`. */
  function pluginRow(profileName: string, plugin: string) {
    const manifest = { description: 'A plugin', name: profileName, plugins: ['plugins/p'] };
    const files = [
      file('profile.json', JSON.stringify(manifest)),
      file('plugins/p/.claude-plugin/plugin.json', JSON.stringify({ name: plugin })),
    ];
    return {
      commitSha: 'abc',
      contentHash: computeContentHash(files, manifest),
      files: packFiles(files),
      manifest,
    };
  }
  const rows: Record<string, ReturnType<typeof pluginRow>> = {};
  beforeEach(() => {
    h.profileFind.mockImplementation(async ({ where }: { where: { name: string } }) => ({
      ...profile({ id: `id-${where.name}` }),
      hooksEnabled: where.name !== 'quiet',
    }));
    h.versionFind.mockImplementation(
      async ({ where }: { where: { profileId_version: { profileId: string } } }) =>
        rows[where.profileId_version.profileId.slice(3)]
    );
  });

  it('resolves every bound plugin in list order, pinning each, with its own hook switch', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    rows.quiet = pluginRow('quiet', 'quiet');
    const row = runRow(null);
    const list = await resolveHarnessProfiles('implementer', {}, binding(['alpha', 'quiet']));
    expect(list.map((p) => [p.name, p.hooksEnabled])).toEqual([
      ['alpha', true],
      ['quiet', false],
    ]);
    expect(row.harnessProfileVersions).toEqual({
      alpha: { hooks: true, version: 2 },
      quiet: { hooks: false, version: 2 },
    });
  });

  it('fails closed when one of several is disabled, naming it', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow(null);
    h.profileFind.mockImplementation(async ({ where }: { where: { name: string } }) =>
      profile({ id: `id-${where.name}`, status: where.name === 'beta' ? 'DISABLED' : 'OK' })
    );
    await expect(
      resolveHarnessProfiles('implementer', {}, binding(['alpha', 'beta']))
    ).rejects.toThrow(/'beta'/);
  });

  it('fails closed on two plugins that share a plugin.json name', async () => {
    rows.alpha = pluginRow('alpha', 'shared');
    rows.beta = pluginRow('beta', 'Shared');
    runRow(null);
    await expect(
      resolveHarnessProfiles('implementer', {}, binding(['alpha', 'beta']))
    ).rejects.toMatchObject({ nonRetryable: true, type: 'PLUGIN_NAME_COLLISION' });
  });

  it('needs no enablement for a platform-wide binding', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow(null);
    await resolveHarnessProfiles('implementer', { teamId: 't1' }, binding(['alpha']));
    expect(h.enabledFind).not.toHaveBeenCalled();
  });

  it('fails closed for a team override whose team has not enabled the plugin', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow(null);
    h.enabledFind.mockResolvedValue([]);
    await expect(
      resolveHarnessProfiles(
        'implementer',
        { teamId: 't1' },
        binding(['alpha'], { scope: 'TEAM', teamId: 't1', version: 4 })
      )
    ).rejects.toMatchObject({ nonRetryable: true, type: 'PLUGIN_NOT_ENABLED' });
    expect(h.enabledFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ teamId: 't1' }) })
    );
  });

  it('serves a team override whose team enabled the plugin', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow(null);
    h.enabledFind.mockResolvedValue([{ profileId: 'id-alpha' }]);
    const list = await resolveHarnessProfiles(
      'implementer',
      { teamId: 't1' },
      binding(['alpha'], { scope: 'TEAM', teamId: 't1', version: 4 })
    );
    expect(list).toHaveLength(1);
  });

  it('fails closed for a TEAM override with no team to check', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow(null);
    await expect(
      resolveHarnessProfiles('implementer', {}, binding(['alpha'], { scope: 'TEAM' }))
    ).rejects.toMatchObject({ type: 'PLUGIN_NOT_ENABLED' });
  });

  it.each(['ORGANIZATION', 'CHANNEL', 'WORKFLOW_TEMPLATE'] as const)(
    'needs no enablement, and no team, for a %s binding',
    async (scope) => {
      rows.alpha = pluginRow('alpha', 'alpha');
      runRow(null);
      h.enabledFind.mockResolvedValue([]);
      const list = await resolveHarnessProfiles('implementer', {}, binding(['alpha'], { scope }));
      expect(list).toHaveLength(1);
      expect(h.enabledFind).not.toHaveBeenCalled();
    }
  );

  const teamBinding = () => binding(['alpha'], { scope: 'TEAM', teamId: 't1', version: 4 });

  it('keeps a run in flight on a binding it verified after the enablement is removed', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow({ alpha: { verified: ['t1:implementer:4'], version: 2 } });
    h.enabledFind.mockResolvedValue([]);
    const list = await resolveHarnessProfiles('implementer', { teamId: 't1' }, teamBinding());
    expect(list).toHaveLength(1);
    expect(h.enabledFind).not.toHaveBeenCalled();
  });

  it('does not let another agent’s pin stand in for a team binding that was never verified', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    // Pinned by a platform-wide binding (bare version): no agent is verified.
    runRow({ alpha: 2 });
    h.enabledFind.mockResolvedValue([]);
    await expect(
      resolveHarnessProfiles('implementer', { teamId: 't1' }, teamBinding())
    ).rejects.toMatchObject({ nonRetryable: true, type: 'PLUGIN_NOT_ENABLED' });
    expect(h.enabledFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ teamId: 't1' }) })
    );
  });

  it('does not exempt a legacy bare-key entry', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow({ alpha: { verified: ['implementer'], version: 2 } });
    h.enabledFind.mockResolvedValue([]);
    await expect(
      resolveHarnessProfiles('implementer', { teamId: 't1' }, teamBinding())
    ).rejects.toMatchObject({ type: 'PLUGIN_NOT_ENABLED' });
  });

  it('does not exempt a different team, or a newer agent version, of a verified key', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow({ alpha: { verified: ['t1:implementer:4'], version: 2 } });
    h.enabledFind.mockResolvedValue([]);
    await expect(
      resolveHarnessProfiles(
        'implementer',
        { teamId: 't2' },
        binding(['alpha'], { scope: 'TEAM', teamId: 't2' })
      )
    ).rejects.toMatchObject({ type: 'PLUGIN_NOT_ENABLED' });
    await expect(
      resolveHarnessProfiles(
        'implementer',
        { teamId: 't1' },
        binding(['alpha'], { scope: 'TEAM', teamId: 't1', version: 5 })
      )
    ).rejects.toMatchObject({ type: 'PLUGIN_NOT_ENABLED' });
  });

  it('passes a newer agent version while the enablement is still present, and verifies it', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    const row = runRow({ alpha: { hooks: true, verified: ['t1:implementer:4'], version: 2 } });
    h.enabledFind.mockResolvedValue([{ profileId: 'id-alpha' }]);
    await resolveHarnessProfiles(
      'implementer',
      { teamId: 't1' },
      binding(['alpha'], { scope: 'TEAM', teamId: 't1', version: 5 })
    );
    expect(row.harnessProfileVersions).toEqual({
      alpha: { hooks: true, verified: ['t1:implementer:4', 't1:implementer:5'], version: 2 },
    });
  });

  it('fails closed for an agent not in the pin’s verified list, even when another is', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow({ alpha: { verified: ['t1:reviewer:4'], version: 2 } });
    h.enabledFind.mockResolvedValue([]);
    await expect(
      resolveHarnessProfiles('implementer', { teamId: 't1' }, teamBinding())
    ).rejects.toMatchObject({ type: 'PLUGIN_NOT_ENABLED' });
  });

  it('serves the pinned version to a not-yet-verified binding that is enabled, and records it', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    const row = runRow({ alpha: 1 });
    h.enabledFind.mockResolvedValue([{ profileId: 'id-alpha' }]);
    const [p] = await resolveHarnessProfiles('implementer', { teamId: 't1' }, teamBinding());
    expect(p?.version).toBe(1);
    expect(row.harnessProfileVersions).toEqual({
      alpha: { hooks: true, verified: ['t1:implementer:4'], version: 1 },
    });
    // Enablement removed afterwards: the run's own verified binding keeps working.
    h.enabledFind.mockResolvedValue([]);
    await expect(
      resolveHarnessProfiles('implementer', { teamId: 't1' }, teamBinding())
    ).resolves.toHaveLength(1);
  });

  it('pins a first use of a team binding with itself verified', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    const row = runRow(null);
    h.enabledFind.mockResolvedValue([{ profileId: 'id-alpha' }]);
    await resolveHarnessProfiles('implementer', { teamId: 't1' }, teamBinding());
    expect(row.harnessProfileVersions).toEqual({
      alpha: { hooks: true, verified: ['t1:implementer:4'], version: 2 },
    });
  });

  it('checks enablement on a caller-supplied pin too', async () => {
    rows.alpha = pluginRow('alpha', 'alpha');
    runRow(null);
    h.enabledFind.mockResolvedValue([]);
    await expect(
      resolveHarnessProfiles(
        'implementer',
        { harnessProfileVersions: { alpha: 2 }, teamId: 't1' },
        teamBinding()
      )
    ).rejects.toMatchObject({ type: 'PLUGIN_NOT_ENABLED' });
  });

  describe('a workflow id reused by a later execution', () => {
    it('ignores the earlier execution’s pin and resolves fresh (status and enablement checked)', async () => {
      rows.alpha = pluginRow('alpha', 'alpha');
      const row = runRow({ alpha: { verified: ['t1:implementer:4'], version: 1 } }, 'exec-0');
      h.enabledFind.mockResolvedValue([]);
      await expect(
        resolveHarnessProfiles('implementer', { teamId: 't1' }, teamBinding())
      ).rejects.toMatchObject({ type: 'PLUGIN_NOT_ENABLED' });
      h.profileFind.mockImplementation(async ({ where }: { where: { name: string } }) =>
        profile({ id: `id-${where.name}`, status: 'DISABLED' })
      );
      await expect(
        resolveHarnessProfiles('implementer', {}, binding(['alpha']))
      ).rejects.toMatchObject({ type: 'PROFILE_UNAVAILABLE' });
      expect(h.runUpdateMany).not.toHaveBeenCalled();
      expect(row.harnessProfileVersions).toEqual({
        alpha: { verified: ['t1:implementer:4'], version: 1 },
      });
    });

    it('resolves the latest version and writes nothing into the earlier execution’s pins', async () => {
      rows.alpha = pluginRow('alpha', 'alpha');
      runRow({ alpha: 1 }, 'exec-0');
      const [p] = await resolveHarnessProfiles('implementer', {}, binding(['alpha']));
      expect(p?.version).toBe(2);
      expect(h.runUpdateMany).not.toHaveBeenCalled();
    });

    it('trusts a map that names this execution even when the row names the first', async () => {
      rows.alpha = pluginRow('alpha', 'alpha');
      runRow(
        { __execution: 'exec-1', alpha: { verified: ['t1:implementer:4'], version: 1 } },
        'exec-0'
      );
      h.enabledFind.mockResolvedValue([]);
      const [p] = await resolveHarnessProfiles('implementer', { teamId: 't1' }, teamBinding());
      expect(p?.version).toBe(1);
    });

    it('treats a row with no execution at all as having no pin', async () => {
      rows.alpha = pluginRow('alpha', 'alpha');
      runRow({ alpha: 1 }, null);
      const [p] = await resolveHarnessProfiles('implementer', {}, binding(['alpha']));
      expect(p?.version).toBe(2);
    });
  });

  describe('hook switch: pinned at run start, effective value is pinned AND live', () => {
    const setup = (pin: Record<string, unknown> | number | null, live: boolean) => {
      rows.alpha = pluginRow('alpha', 'alpha');
      h.profileFind.mockImplementation(async ({ where }: { where: { name: string } }) => ({
        ...profile({ id: `id-${where.name}` }),
        hooksEnabled: live,
      }));
      return runRow(pin === null ? null : { alpha: pin });
    };
    const resolve = async () =>
      (await resolveHarnessProfiles('implementer', {}, binding(['alpha'])))[0];

    it.each([
      [true, true, true],
      [true, false, false],
      [false, true, false],
      [false, false, false],
    ])('pinned %s and live %s is effective %s', async (pinned, live, effective) => {
      setup({ hooks: pinned, version: 2 }, live);
      expect(await resolve()).toMatchObject({
        hooksEnabled: effective,
        hooksLive: live,
        hooksPinned: pinned,
      });
      expect(h.runUpdateMany).not.toHaveBeenCalled();
    });

    it('reads an old pin (a bare version) live once and pins it at first use', async () => {
      const row = setup(2, true);
      expect(await resolve()).toMatchObject({
        hooksEnabled: true,
        hooksLive: true,
        hooksPinned: true,
      });
      expect(row.harnessProfileVersions).toEqual({ alpha: { hooks: true, version: 2 } });
    });

    it('an old pin read while hooks are off pins OFF, so a later switch-on is not gained', async () => {
      const row = setup({ verified: [], version: 2 }, false);
      expect((await resolve())?.hooksEnabled).toBe(false);
      expect(row.harnessProfileVersions).toEqual({ alpha: { hooks: false, version: 2 } });
      h.profileFind.mockImplementation(async ({ where }: { where: { name: string } }) => ({
        ...profile({ id: `id-${where.name}` }),
        hooksEnabled: true,
      }));
      expect(await resolve()).toMatchObject({ hooksEnabled: false, hooksLive: true });
    });

    it('never overwrites a pinned hook switch', async () => {
      const row = setup({ hooks: false, version: 2 }, true);
      await resolve();
      expect(row.harnessProfileVersions).toEqual({ alpha: { hooks: false, version: 2 } });
    });

    it('pins the live switch at first use alongside the version', async () => {
      const row = setup(null, false);
      expect(await resolve()).toMatchObject({ hooksEnabled: false, hooksPinned: false });
      expect(row.harnessProfileVersions).toEqual({ alpha: { hooks: false, version: 2 } });
    });

    it('with no run row to pin on, the live value stands as the pinned one', async () => {
      h.inActivity.value = false;
      setup(null, true);
      expect(await resolve()).toMatchObject({ hooksEnabled: true, hooksPinned: true });
    });
  });

  it('records plugin_partial for several plugins on another runtime', async () => {
    const tracer = { addActivityEvent: vi.fn() };
    await resolveProfileForRuntime({
      agentKey: 'implementer',
      ctx: undefined,
      resolved: binding(['alpha', 'beta']),
      runtime: 'mastra',
      tracer,
    });
    expect(tracer.addActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agent.plugin_partial',
        outputJson: expect.objectContaining({ profiles: ['alpha', 'beta'] }),
      })
    );
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

  it('adds a verified agent to an existing pin without changing its version', async () => {
    const row = runRow({ kit: 1 });
    const v = await pinHarnessProfileVersion('wf-1', 'kit', 9, {
      runId: 'exec-1',
      verifiedKey: 't1:implementer:4',
    });
    expect(v).toBe(1);
    expect(row.harnessProfileVersions).toEqual({
      kit: { verified: ['t1:implementer:4'], version: 1 },
    });
  });

  it('writes nothing when the pins belong to another execution', async () => {
    const row = runRow({ kit: 1 }, 'exec-0');
    expect(await pinHarnessProfileVersion('wf-1', 'kit', 9, { runId: 'exec-1' })).toBe(9);
    expect(h.runUpdateMany).not.toHaveBeenCalled();
    expect(row.harnessProfileVersions).toEqual({ kit: 1 });
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
    expect(resolved?.[0]).toMatchObject({ name: 'kit', version: 2 });
    expect(given.tracer.addActivityEvent).not.toHaveBeenCalled();
  });

  it('returns undefined, with no event, for an agent bound to no profile', async () => {
    h.resolveAgent.mockResolvedValue(binding([]));
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
      outputJson: {
        agentKey: 'implementer',
        profile: 'kit',
        profiles: ['kit'],
        ranOn: runtime,
        runtime,
      },
    });
    expect(given.tracer.addActivityEvent).toHaveBeenCalledWith({
      name: 'agent.plugin_partial',
      outputJson: {
        agentKey: 'implementer',
        profiles: ['kit'],
        ranOn: runtime,
        runtime,
        skipped: ['commands', 'hooks', 'sub-agents'],
      },
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
        profiles: ['kit'],
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
