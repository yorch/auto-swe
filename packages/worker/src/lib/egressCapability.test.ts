import type { PrismaClient } from '@auto-swe/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeEgressCapability, startEgressReporting } from './egressCapability.js';
import type { WorkspaceBackend } from './workspaceBackend/types.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('worker egress reporting', () => {
  it.each(['stderr', 'empty', 'long', 'cleanup'])(
    'stores a bounded reason, retaining full logs: %s',
    async (mode) => {
      vi.stubEnv('WORKSPACE_BACKEND', 'docker');
      const diagnostic =
        mode === 'long'
          ? 'failed '.repeat(100)
          : 'sh: apk: not found\negress lock: helper image has no iptables';
      const error = Object.assign(
        new Error(`Command failed: docker run sh -c '${'iptables script;'.repeat(100)}'`),
        { stderr: mode === 'empty' ? '' : diagnostic }
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const backend = {
        create: vi.fn().mockRejectedValue(error),
        remove:
          mode === 'cleanup'
            ? vi.fn().mockRejectedValue(error)
            : vi.fn().mockResolvedValue(undefined),
      } as unknown as WorkspaceBackend;
      const result = await probeEgressCapability(backend);
      expect(result.networkLock).toBe(false);
      expect(result.detail.length).toBeLessThanOrEqual(300);
      expect(result.detail).not.toContain('iptables script');
      expect(warn).toHaveBeenCalledWith('Worker cannot enforce egress network locks:', error);
      if (mode === 'stderr') {
        expect(result.detail).toBe('sh: apk: not found egress lock: helper image has no iptables');
      }
      if (mode === 'empty') {
        expect(result.detail).toBe('Probe command failed without diagnostic output.');
      }
      if (mode === 'cleanup') {
        expect(result.detail).toContain('Probe cleanup failed: sh: apk: not found');
      }
    }
  );
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
