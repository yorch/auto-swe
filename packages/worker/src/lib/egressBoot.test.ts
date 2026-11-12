import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ policy: 'restricted', proxy: false }));
vi.mock('@auto-swe/shared/config', () => ({ resolveSetting: vi.fn(async () => h.policy) }));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveWorkspaceInfra: () => ({ egressProxy: h.proxy ? {} : null }),
}));

import { resolveSetting } from '@auto-swe/shared/config';
import { assertGlobalEgressReady } from './egressBoot.js';

describe('GLOBAL egress boot guard', () => {
  it('refuses the restricted default without a proxy and names both fixes', async () => {
    h.policy = 'restricted';
    h.proxy = false;
    await expect(assertGlobalEgressReady()).rejects.toThrow(
      /Configure EGRESS_PROXY_PORT.*GLOBAL workspace.egressPolicy to open/
    );
    expect(resolveSetting).toHaveBeenLastCalledWith('workspace.egressPolicy', {});
  });
  it('starts restricted with a configured proxy', async () => {
    h.policy = 'restricted';
    h.proxy = true;
    await expect(assertGlobalEgressReady()).resolves.toBeUndefined();
  });
  it.each(['open', 'blocked'])('starts GLOBAL %s without a proxy', async (policy) => {
    h.policy = policy;
    h.proxy = false;
    await expect(assertGlobalEgressReady()).resolves.toBeUndefined();
  });
});
