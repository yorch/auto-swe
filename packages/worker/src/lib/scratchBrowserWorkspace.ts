import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '@auto-swe/shared/db';
import { effectiveEgressAllowlist } from '@auto-swe/shared/lib/egressPolicy';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import type { BrowserWorkspace } from '../browser/session.js';
import { workerEgressProxy } from './egressProxy.js';
import { beginWorkspaceEgress, resolveRunEgressPolicy } from './egressWiring.js';
import { workspaceBackend } from './workspaceBackend/index.js';
import {
  extractSingleFileFromArchive,
  readSingleFileFromArchive,
} from './workspaceBackend/kubernetes/safeTar.js';
import { agentWorkspaceSpec } from './workspaceBackend/spec.js';
import type { WorkspaceHandle } from './workspaceBackend/types.js';
import { resolveRunWorkspaceSize } from './workspaceSizing.js';

/**
 * The throwaway container behind the browser of a run with no repository.
 *
 * A repo-less orchestration child has no clone, no credential and no workspace tool, but its Agent
 * may still grant `browser`. The browser needs a container, so this makes one that holds nothing
 * but a browser:
 *
 * - no repository, no git configuration, no GitHub token, no model or MCP credential, no registry
 *   wiring. The only environment it carries is the egress proxy's (the proxy address, its
 *   `NO_PROXY` list, and the registration token that scopes the container to its allowlist);
 * - egress is ALWAYS `restricted`, whatever the run's own policy says short of `blocked`, and it is
 *   locked to the egress proxy's address alone, so `--noproxy` and raw sockets reach nothing. The
 *   model proxy, registry proxy and any git host that a repository workspace keeps are not
 *   reachable here;
 * - the hosts it may reach are the team's own allowlist entries and nothing else: the global
 *   `workspace.egressBaselineAllowlist` (a code host, package registries) is not merged in, since
 *   a browser with no repository needs none of it. The proxy registration and the browser
 *   driver's navigation list are the same array, and a team with no entries gets no browser;
 * - it is never created unless that can be enforced. A `blocked` run policy, a worker without the
 *   egress proxy, an empty team allowlist, the Kubernetes backend, a failed network lock and an
 *   image with no browser each return `{ ok: false }` with a reason, and the caller runs the
 *   child without a browser. There is no fallback to open egress.
 *
 * Kubernetes is refused because its lock leaves cluster DNS reachable (see the description of
 * `workspace.egressPolicy`), and script in a page can encode data into a DNS lookup (a WebRTC
 * STUN hostname) that never passes the proxy. Only the Docker backend closes every other path.
 *
 * It does not go through `createWorkspace`, which is built around a clone and a credential. The
 * image is the deployment's configured workspace image (`resolveWorkspaceInfra().image`, the one
 * `createWorkspace` itself falls back to), so an operator who wants UI validation sets it to the
 * browser executor image; an image without Chromium is detected before the agent starts.
 */

/** The in-container check the browser session itself runs before it starts a driver. */
const BROWSER_CHECK =
  'require.resolve("playwright"); const p=require("playwright"); require("node:fs").accessSync(p.chromium.executablePath())';

export interface ScratchBrowserWorkspace extends BrowserWorkspace {
  readonly containerId: string;
  readonly egressPolicy: 'restricted';
  /** Removes the container and releases the egress registration. Idempotent. */
  destroy(): Promise<void>;
}

export type ScratchBrowserResult =
  | {
      ok: true;
      workspace: ScratchBrowserWorkspace;
      /** The count of hosts the egress proxy admits and the browser may navigate to, not the hosts. */
      allowedHostCount: number;
      allowedHosts: string[];
    }
  | { ok: false; reason: string };

const unavailable = (reason: string): ScratchBrowserResult => ({ ok: false, reason });

export async function createScratchBrowserWorkspace(input: {
  teamId: string | null;
}): Promise<ScratchBrowserResult> {
  const { teamId } = input;
  const policy = await resolveRunEgressPolicy(teamId);
  if (policy === 'blocked') {
    return unavailable("the run's egress policy is 'blocked'");
  }
  if (!workerEgressProxy()) {
    return unavailable(
      'the worker egress proxy is not configured, so restricted egress cannot be enforced'
    );
  }
  const infra = resolveWorkspaceInfra();
  if (infra.backend === 'kubernetes') {
    return unavailable(
      'the workspace backend is Kubernetes, where cluster DNS stays reachable under the egress lock, so page script could leak data through DNS; the browser needs the Docker backend'
    );
  }
  const team = teamId
    ? await prisma.team.findUnique({ select: { egressAllowlist: true }, where: { id: teamId } })
    : null;
  // The team's own entries only: no baseline. This one array is both what the proxy admits and
  // what the browser may navigate to.
  const allowedHosts = effectiveEgressAllowlist('restricted', team?.egressAllowlist ?? [], []);
  if (allowedHosts.length === 0) {
    return unavailable("the team's egress allowlist is empty");
  }
  const image = infra.image;
  if (!DOCKER_IMAGE_REF_RE.test(image)) {
    return unavailable('the configured workspace image is not a valid image reference');
  }
  const backend = workspaceBackend();
  const name = `workspace-${crypto.randomBytes(8).toString('hex')}`;
  let egress: Awaited<ReturnType<typeof beginWorkspaceEgress>> = null;
  let destroyed = false;
  const destroy = async () => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    await egress?.registration.release().catch(() => {});
    await backend.remove(name);
  };
  try {
    egress = await beginWorkspaceEgress(teamId, [], 'restricted', {
      additionalHosts: allowedHosts,
      includeTeamAllowlist: false,
    });
    if (!egress) {
      return unavailable('the egress proxy returned no registration');
    }
    const size = await resolveRunWorkspaceSize(teamId, infra);
    const spec = agentWorkspaceSpec(name, image, infra, undefined, size);
    spec.reachWorker = true;
    spec.baselineAllow = [];
    spec.env = [...egress.env];
    spec.secretEnv = { ...egress.secretEnv };
    const handle: WorkspaceHandle = await backend.create(spec);
    const proxy = new URL(egress.registration.url);
    await backend.lockEgress(
      handle,
      [
        {
          host: proxy.hostname.replace(/^\[|\]$/g, ''),
          port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
        },
      ],
      { mode: 'restricted' }
    );
    const probe = await backend.exec(handle, ['sh', '-c', `node -e '${BROWSER_CHECK}'`], {
      heartbeatLabel: 'scratch browser workspace: checking the browser',
      timeoutMs: 20_000,
    });
    if (probe.exitCode !== 0) {
      await destroy();
      return unavailable('the configured workspace image has no browser');
    }
    return {
      allowedHostCount: allowedHosts.length,
      allowedHosts,
      ok: true,
      workspace: scratchWorkspace(name, handle, backend, destroy),
    };
  } catch (error) {
    await destroy().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(`the scratch container could not be started: ${message.slice(0, 300)}`);
  }
}

function scratchWorkspace(
  name: string,
  handle: WorkspaceHandle,
  backend: ReturnType<typeof workspaceBackend>,
  destroy: () => Promise<void>
): ScratchBrowserWorkspace {
  const copyOut = async (filePath: string, maxBytes: number, dir: string) => {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError('maxBytes must be a non-negative safe integer');
    }
    const archivePath = path.join(dir, 'file.tar');
    const copied = await backend.copyOut(handle, filePath, archivePath, {
      heartbeatLabel: 'scratch browser workspace: reading a file',
      maxBytes: Math.min(Number.MAX_SAFE_INTEGER, maxBytes + 128 * 1024),
      timeoutMs: 60_000,
    });
    if (copied.exceeded) {
      throw new RangeError(`workspace file exceeds the ${maxBytes} byte limit`);
    }
    if (copied.exitCode !== 0) {
      throw new Error(
        `Could not read workspace file "${filePath}": ${copied.stderr.trim() || 'copy failed'}`
      );
    }
    return archivePath;
  };
  return {
    containerId: name,
    copyFileOut: async (filePath, maxBytes) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'workspace-file-'));
      try {
        const archive = await copyOut(filePath, maxBytes, dir);
        const destPath = path.join(dir, 'file');
        const extracted = await extractSingleFileFromArchive(archive, destPath, maxBytes);
        return {
          cleanup: () => rm(dir, { force: true, recursive: true }),
          path: destPath,
          sizeBytes: extracted.sizeBytes,
        };
      } catch (error) {
        await rm(dir, { force: true, recursive: true });
        throw error;
      }
    },
    destroy,
    egressPolicy: 'restricted',
    exec: (command, options) =>
      backend.execShell(handle, ['sh', '-c', command], {
        heartbeatLabel: 'scratch browser workspace: exec',
        timeoutMs: options?.timeoutMs,
      }),
    execStdin: async (command, stdin) => {
      const result = await backend.exec(handle, ['sh', '-c', command], {
        heartbeatLabel: 'scratch browser workspace: exec (stdin)',
        stdin,
      });
      if (result.exitCode !== 0) {
        throw Object.assign(
          new Error(`Command failed (exit code ${result.exitCode}): ${command}`),
          { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout }
        );
      }
      return result.stdout;
    },
    readFile: async (filePath, maxBytes) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'workspace-file-'));
      try {
        return await readSingleFileFromArchive(await copyOut(filePath, maxBytes, dir), maxBytes);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  };
}
