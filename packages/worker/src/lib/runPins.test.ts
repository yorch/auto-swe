import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  agentFind: vi.fn(),
  binding: vi.fn(),
  enabledFind: vi.fn(),
  exec: { value: null as string | null },
  profileFind: vi.fn(),
}));

vi.mock('./activityContext.js', () => ({ currentTemporalRunId: () => h.exec.value }));

vi.mock('@auto-swe/shared/db', () => ({
  prisma: {
    agent: { findMany: h.agentFind },
    harnessProfile: { findMany: h.profileFind },
    pluginEnablement: { findMany: h.enabledFind },
  },
}));
vi.mock('./config/agentResolver.js', () => ({
  resolveAgentProfileBinding: h.binding,
  resolveAgentRuntimeChoice: vi.fn(),
}));

import { snapshotHarnessProfileVersions } from './runPins.js';

beforeEach(() => {
  vi.clearAllMocks();
  h.exec.value = null;
  h.agentFind.mockResolvedValue([{ key: 'implementer' }, { key: 'reviewer' }]);
  h.profileFind.mockResolvedValue([
    { hooksEnabled: true, id: 'id-a', latestVersion: 3, name: 'a' },
    { hooksEnabled: false, id: 'id-b', latestVersion: 1, name: 'b' },
  ]);
  h.enabledFind.mockResolvedValue([]);
});

describe('snapshotHarnessProfileVersions', () => {
  it('pins every plugin of a platform-wide binding, with no enablement lookup', async () => {
    h.binding.mockResolvedValue({ harnessProfiles: ['a', 'b'], scope: 'GLOBAL', teamId: null });
    expect(await snapshotHarnessProfileVersions({ teamId: 't1' })).toEqual({
      a: { hooks: true, version: 3 },
      b: { hooks: false, version: 1 },
    });
    expect(h.enabledFind).not.toHaveBeenCalled();
  });

  it('pins a team binding only for the plugins the team enabled', async () => {
    h.agentFind.mockResolvedValue([{ key: 'implementer' }]);
    h.binding.mockResolvedValue({ harnessProfiles: ['a', 'b'], scope: 'TEAM', teamId: 't1' });
    h.enabledFind.mockResolvedValue([{ profileId: 'id-b' }]);
    expect(await snapshotHarnessProfileVersions({ teamId: 't1' })).toEqual({
      b: { hooks: false, verified: ['implementer'], version: 1 },
    });
    expect(h.enabledFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ teamId: 't1' }) })
    );
  });

  it('records which agents’ team bindings passed the enablement check', async () => {
    h.agentFind.mockResolvedValue([{ key: 'implementer' }, { key: 'reviewer' }]);
    h.binding.mockImplementation(async (key: string) =>
      key === 'reviewer'
        ? { harnessProfiles: ['b'], scope: 'GLOBAL', teamId: null }
        : { harnessProfiles: ['a', 'b'], scope: 'TEAM', teamId: 't1' }
    );
    h.enabledFind.mockResolvedValue([{ profileId: 'id-b' }]);
    // `b` is platform-wide for reviewer and team-verified for implementer; `a` is not enabled.
    expect(await snapshotHarnessProfileVersions({ teamId: 't1' })).toEqual({
      b: { hooks: false, verified: ['implementer'], version: 1 },
    });
  });

  it('pins a plugin from a platform-wide binding unverified, leaving a team binding unverified', async () => {
    h.agentFind.mockResolvedValue([{ key: 'implementer' }, { key: 'reviewer' }]);
    h.binding.mockImplementation(async (key: string) =>
      key === 'reviewer'
        ? { harnessProfiles: ['a'], scope: 'GLOBAL', teamId: null }
        : { harnessProfiles: ['a'], scope: 'TEAM', teamId: 't1' }
    );
    h.enabledFind.mockResolvedValue([]);
    expect(await snapshotHarnessProfileVersions({ teamId: 't1' })).toEqual({
      a: { hooks: true, version: 3 },
    });
  });

  it('stamps the execution it was taken for', async () => {
    h.binding.mockResolvedValue({ harnessProfiles: [], scope: 'GLOBAL', teamId: null });
    h.exec.value = 'exec-9';
    expect(await snapshotHarnessProfileVersions({})).toEqual({ __execution: 'exec-9' });
    h.binding.mockResolvedValue({ harnessProfiles: ['a'], scope: 'GLOBAL', teamId: null });
    expect(await snapshotHarnessProfileVersions({})).toEqual({
      __execution: 'exec-9',
      a: { hooks: true, version: 3 },
    });
  });

  it('leaves out a TEAM binding with no team to check', async () => {
    h.agentFind.mockResolvedValue([{ key: 'implementer' }]);
    h.binding.mockResolvedValue({ harnessProfiles: ['a'], scope: 'TEAM', teamId: null });
    expect(await snapshotHarnessProfileVersions({})).toEqual({});
  });

  it.each(['ORGANIZATION', 'CHANNEL', 'WORKFLOW_TEMPLATE'])(
    'pins a %s binding with no enablement lookup and no team',
    async (scope) => {
      h.agentFind.mockResolvedValue([{ key: 'implementer' }]);
      h.binding.mockResolvedValue({ harnessProfiles: ['a'], scope, teamId: null });
      expect(await snapshotHarnessProfileVersions({})).toEqual({
        a: { hooks: true, version: 3 },
      });
      expect(h.enabledFind).not.toHaveBeenCalled();
    }
  );
});
