import type { PrismaClient } from '@auto-swe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeEgressCapability, startEgressReporting } from './egressCapability.js';
import type { WorkspaceBackend } from './workspaceBackend/types.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('worker egress reporting', () => {
  it.each(['ok', 'create', 'lock'])(
    'probes through real backend operations and cleans up: %s',
    async (failure) => {
      vi.stubEnv('WORKSPACE_BACKEND', 'docker');
      const events: string[] = [];
      const backend = {
        create: vi.fn(async () => {
          events.push('baseline');
          if (failure === 'create') {
            throw new Error('no iptables');
          }
          return { id: 'probe', keeperPid: 1 };
        }),
        lockEgress: vi.fn(async () => {
          events.push('strict');
          if (failure === 'lock') {
            throw new Error('strict verification failed');
          }
        }),
        remove: vi.fn(async () => {
          events.push('remove');
        }),
      } as unknown as WorkspaceBackend;
      const result = await probeEgressCapability(backend);
      expect(result.networkLock).toBe(failure === 'ok');
      expect(events).toEqual(
        failure === 'create' ? ['baseline', 'remove'] : ['baseline', 'strict', 'remove']
      );
      if (failure !== 'ok') {
        expect(result.detail).toContain(
          failure === 'create' ? 'no iptables' : 'strict verification failed'
        );
      }
      if (failure === 'ok') {
        expect(backend.lockEgress).toHaveBeenCalledWith({ id: 'probe', keeperPid: 1 }, [], {
          mode: 'blocked',
        });
      }
    }
  );
  it('uses the Kubernetes startup gate without creating a Docker probe', async () => {
    vi.stubEnv('WORKSPACE_BACKEND', 'kubernetes');
    vi.stubEnv('K8S_REQUIRE_NETWORK_POLICY', 'true');
    const backend = { create: vi.fn() } as unknown as WorkspaceBackend;
    expect((await probeEgressCapability(backend)).networkLock).toBe(true);
    expect(backend.create).not.toHaveBeenCalled();
    vi.stubEnv('K8S_REQUIRE_NETWORK_POLICY', 'false');
    expect(await probeEgressCapability(backend)).toMatchObject({
      detail: expect.stringContaining('disabled'),
      networkLock: false,
    });
  });
  it('upserts once, refreshes only its timestamp, and removes its row after stopping', async () => {
    vi.useFakeTimers();
    const prisma = {
      workerEgressCapability: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    };
    const capability = {
      backend: 'docker',
      detail: '',
      egressProxy: false,
      networkLock: true,
      registryProxy: true,
    };
    const stop = await startEgressReporting(prisma as unknown as PrismaClient, capability, 'queue');
    expect(prisma.workerEgressCapability.upsert).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(prisma.workerEgressCapability.upsert).toHaveBeenCalledTimes(2);
    const args = prisma.workerEgressCapability.upsert.mock.calls[1][0];
    expect(args.update).toEqual({ reportedAt: expect.any(Date) });
    await stop();
    expect(prisma.workerEgressCapability.deleteMany).toHaveBeenCalledWith({ where: args.where });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(prisma.workerEgressCapability.upsert).toHaveBeenCalledTimes(2);
  });
});
