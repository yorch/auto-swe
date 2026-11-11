import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { PrismaClient } from '@auto-swe/shared';
import type { WorkerEgressReport } from '@auto-swe/shared/lib/egressPolicy';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { workspaceBackend } from './workspaceBackend/index.js';
import type { WorkspaceBackend } from './workspaceBackend/types.js';

export async function probeEgressCapability(
  backend: WorkspaceBackend = workspaceBackend()
): Promise<Omit<WorkerEgressReport, 'id' | 'reportedAt'>> {
  const infra = resolveWorkspaceInfra();
  const result = {
    backend: infra.backend,
    detail: '',
    egressProxy: !!infra.egressProxy,
    networkLock: false,
    registryProxy: !!infra.registryProxy,
  };
  if (infra.backend === 'kubernetes') {
    return {
      ...result,
      detail: infra.kubernetes.requireNetworkPolicy
        ? ''
        : 'NetworkPolicy enforcement probe is disabled (K8S_REQUIRE_NETWORK_POLICY=false).',
      networkLock: infra.kubernetes.requireNetworkPolicy,
    };
  }
  const name = `workspace-egress-probe-${randomUUID()}`;
  try {
    const handle = await backend.create({
      cpus: infra.cpus,
      dns: infra.dns,
      image: infra.metadataBlockImage,
      memory: infra.memory,
      name,
      pidsLimit: infra.pidsLimit,
      ...(infra.network ? { network: infra.network } : {}),
      reachWorker: true,
    });
    await backend.lockEgress(handle, [], { mode: 'blocked' });
    result.networkLock = true;
  } catch (error) {
    result.detail = error instanceof Error ? error.message : String(error);
    console.warn('Worker cannot enforce egress network locks:', result.detail);
  } finally {
    try {
      await backend.remove(name);
    } catch (error) {
      result.networkLock = false;
      result.detail = `Probe cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(result.detail);
    }
  }
  return result;
}

export async function startEgressReporting(
  prisma: PrismaClient,
  capability: Awaited<ReturnType<typeof probeEgressCapability>>,
  taskQueue: string
) {
  const id = `${hostname()}:${taskQueue}:${process.pid}:${randomUUID()}`;
  const report = async () => {
    const reportedAt = new Date();
    await prisma.workerEgressCapability.upsert({
      create: { id, ...capability, reportedAt },
      update: { reportedAt },
      where: { id },
    });
  };
  await report();
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(report)
      .catch((error) => console.warn('Egress capability refresh failed:', error));
  }, 10 * 60_000);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
    await prisma.workerEgressCapability.deleteMany({ where: { id } });
  };
}
