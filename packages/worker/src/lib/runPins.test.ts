import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  agentFind: vi.fn(),
  binding: vi.fn(),
  enabledFind: vi.fn(),
  profileFind: vi.fn(),
}));

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
  h.agentFind.mockResolvedValue([{ key: 'implementer' }, { key: 'reviewer' }]);
  h.profileFind.mockResolvedValue([
    { id: 'id-a', latestVersion: 3, name: 'a' },
    { id: 'id-b', latestVersion: 1, name: 'b' },
  ]);
  h.enabledFind.mockResolvedValue([]);
});

describe('snapshotHarnessProfileVersions', () => {
  it('pins every plugin of a platform-wide binding, with no enablement lookup', async () => {
    h.binding.mockResolvedValue({ harnessProfiles: ['a', 'b'], scope: 'GLOBAL', teamId: null });
    expect(await snapshotHarnessProfileVersions({ teamId: 't1' })).toEqual({ a: 3, b: 1 });
    expect(h.enabledFind).not.toHaveBeenCalled();
  });

  it('pins a team binding only for the plugins the team enabled', async () => {
    h.agentFind.mockResolvedValue([{ key: 'implementer' }]);
    h.binding.mockResolvedValue({ harnessProfiles: ['a', 'b'], scope: 'TEAM', teamId: 't1' });
    h.enabledFind.mockResolvedValue([{ profileId: 'id-b' }]);
    expect(await snapshotHarnessProfileVersions({ teamId: 't1' })).toEqual({ b: 1 });
    expect(h.enabledFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ teamId: 't1' }) })
    );
  });

  it('leaves out a scoped binding with no team to check', async () => {
    h.agentFind.mockResolvedValue([{ key: 'implementer' }]);
    h.binding.mockResolvedValue({ harnessProfiles: ['a'], scope: 'ORGANIZATION', teamId: null });
    expect(await snapshotHarnessProfileVersions({})).toEqual({});
  });
});
