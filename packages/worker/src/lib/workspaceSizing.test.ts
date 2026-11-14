import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolve: vi.fn(async (_key: string, _scope: unknown): Promise<unknown> => undefined),
  scope: vi.fn(async (_teamId: string | null): Promise<Record<string, unknown>> => ({})),
  settings: { 'workspace.cpus': 0 as unknown, 'workspace.memory': '' as unknown },
  warn: vi.fn(),
}));

vi.mock('./activityLog.js', () => ({ logWarn: h.warn }));
vi.mock('./egressWiring.js', () => ({ resolveEgressScope: h.scope }));
vi.mock('@auto-swe/shared/config', async (importActual) => ({
  ...(await importActual<typeof import('@auto-swe/shared/config')>()),
  resolveSetting: h.resolve,
}));

import { resolveRunWorkspaceSize } from './workspaceSizing.js';

const infra = { cpus: 2, memory: '4g' } as Parameters<typeof resolveRunWorkspaceSize>[1];

beforeEach(() => {
  h.settings['workspace.cpus'] = 0;
  h.settings['workspace.memory'] = '';
  h.scope.mockReset().mockResolvedValue({});
  h.resolve
    .mockReset()
    .mockImplementation(async (key) => h.settings[key as 'workspace.cpus' | 'workspace.memory']);
  h.warn.mockReset();
});

describe('resolveRunWorkspaceSize', () => {
  it('reads both settings in the run scope: the team, the template and the run pins', async () => {
    // The mocked resolver ignores its scope, so without this a call with no scope, which silently
    // resolves the GLOBAL value, would pass every other test here.
    const scope = {
      pinnedSettings: { 'workspace.memory': '8g' },
      teamId: 'team-1',
      workflowTemplateId: 'tpl-1',
    };
    h.scope.mockResolvedValueOnce(scope);
    await resolveRunWorkspaceSize('team-1', infra);
    expect(h.resolve).toHaveBeenCalledWith('workspace.memory', scope);
    expect(h.resolve).toHaveBeenCalledWith('workspace.cpus', scope);
    expect(h.resolve.mock.calls.every(([, passed]) => passed === scope)).toBe(true);
  });

  it('uses the deployment values while both settings are unset', async () => {
    expect(await resolveRunWorkspaceSize('team-1', infra)).toEqual({ cpus: 2, memory: '4g' });
    expect(h.scope).toHaveBeenCalledWith('team-1');
  });

  it('uses a set value, independently for memory and cpus', async () => {
    h.settings['workspace.memory'] = '8g';
    expect(await resolveRunWorkspaceSize(null, infra)).toEqual({ cpus: 2, memory: '8g' });
    h.settings['workspace.memory'] = '';
    h.settings['workspace.cpus'] = 0.5;
    expect(await resolveRunWorkspaceSize(null, infra)).toEqual({ cpus: 0.5, memory: '4g' });
  });

  it('falls back to the deployment value for a stored value the schema refuses', async () => {
    h.settings['workspace.memory'] = '4g --privileged';
    h.settings['workspace.cpus'] = 99;
    expect(await resolveRunWorkspaceSize('team-1', infra)).toEqual({ cpus: 2, memory: '4g' });
  });

  it('does not throw when the scope or the setting cannot be read', async () => {
    h.scope.mockRejectedValueOnce(new Error('db down'));
    expect(await resolveRunWorkspaceSize('team-1', infra)).toEqual({ cpus: 2, memory: '4g' });
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('using the deployment values'), {
      error: 'db down',
    });
  });
});
