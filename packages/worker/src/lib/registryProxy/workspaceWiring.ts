/**
 * Wiring between `createWorkspace` and the registry proxy: resolve which
 * registries a team's workspace may use, register it, and produce everything
 * the container side needs — env for `docker run`, the npmrc, the Berry rc —
 * while the credential itself never leaves the worker.
 */
import { prisma } from '@auto-swe/shared/db';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  buildAllowlist,
  LOCKFILE_NAMES,
  parseLockfile,
} from '@auto-swe/shared/lib/lockfileAllowlist';
import { resolvePackageRegistries } from '@auto-swe/shared/lib/packageRegistry';
import { logWarn } from '../activityLog.js';
import { shellQuote } from '../shellQuote.js';

export { registryWorkspaceEnv, renderNpmrc, renderYarnrc } from './render.js';

import type { RegistryRegistration, ResolvedRegistry } from './index.js';
import { workerRegistryProxy } from './index.js';
import { registryWorkspaceEnv } from './render.js';

/** Lockfiles larger than this are skipped — a generated blob is not a package manifest. */
const LOCKFILE_MAX_BYTES = 50 * 1024 * 1024;
const LOCKFILE_MAX_FILES = 50;

export interface WorkspaceRegistryAccess {
  /** Container env for `docker run`. */
  env: string[];
  /** The proxy baseUrl, for npmrc/scope rendering. */
  baseUrl: string;
  token: string;
  registries: {
    accessMode: string;
    id: string;
    isDefault: boolean;
    name: string;
    scopes: string[];
  }[];
  registration: RegistryRegistration;
}

/**
 * Resolve and register this workspace's registries, or `null` when no wiring
 * applies (proxy off, no team given, or no registries resolve). The
 * registration stays in its not-ready 503 state until the caller sets the
 * allowlist.
 */
export async function beginWorkspaceRegistries(
  teamId: string | null,
  containerName: string
): Promise<WorkspaceRegistryAccess | null> {
  const proxy = workerRegistryProxy();
  if (!proxy || !teamId) {
    return null;
  }
  const rows = await prisma.packageRegistry.findMany({
    where: { isActive: true, OR: [{ teamId }, { teamId: null }] },
  });
  const resolved = resolvePackageRegistries(rows, teamId);
  if (resolved.length === 0) {
    return null;
  }
  const registries: ResolvedRegistry[] = resolved.map(({ registry }) => ({
    allowPrivateNetwork: registry.allowPrivateNetwork,
    authKind: registry.authKind === 'basic' ? 'basic' : 'bearer',
    id: registry.id,
    name: registry.name,
    token: registry.tokenCiphertext
      ? decryptSecret({
          authTag: registry.tokenAuthTag as Buffer,
          ciphertext: registry.tokenCiphertext,
          keyVersion: registry.tokenKeyVersion as number,
          nonce: registry.tokenNonce as Buffer,
        })
      : null,
    upstreamUrl: registry.upstreamUrl,
  }));
  const registration = await proxy.register({
    onDenied(d) {
      // Bind happens inside the proxy (AsyncResource) so this runs in the
      // registering activity's context.
      logWarn('registry proxy denied a package request', {
        container: containerName,
        name: d.name,
        reason: d.reason,
        registryId: d.registryId,
        version: d.version,
      });
    },
    registries,
  });
  const regView = resolved.map(({ isDefault, registry, scopes }) => ({
    accessMode: registry.accessMode,
    id: registry.id,
    isDefault,
    name: registry.name,
    scopes,
  }));
  return {
    baseUrl: registration.baseUrl,
    env: registryWorkspaceEnv(regView, registration.baseUrl, registration.token),
    registration,
    registries: regView,
    token: registration.token,
  };
}

/**
 * The lockfile-derived allowlist, keyed by registry id. An `open`-mode
 * registry maps to `null` (no check); a lockfile-mode one maps to the union
 * of every parsed lockfile — including an empty set when the repo has none.
 * `exec` runs `sh -c` in the workspace and returns stdout.
 */
export async function buildRegistryAllowlist(
  access: WorkspaceRegistryAccess,
  ref: string,
  exec: (command: string, maxOutputBytes?: number) => Promise<{ stdout: string }>
): Promise<Map<string, Map<string, Set<string>> | null>> {
  const map = new Map<string, Map<string, Set<string>> | null>();
  const combined = new Map<string, Set<string>>();
  const listOut = await exec(
    `cd /workspace/target-repo && git ls-tree -r --name-only -z ${shellQuote(ref)}`
  );
  const all = listOut.stdout
    .split('\0')
    .filter((p) => LOCKFILE_NAMES.has(p.split('/').pop() ?? ''));
  if (all.length > LOCKFILE_MAX_FILES) {
    logWarn('registry allowlist: more lockfiles than the cap, keeping the first', {
      count: all.length,
      ref,
    });
  }
  const paths = all.slice(0, LOCKFILE_MAX_FILES);
  for (const path of paths) {
    // Size first: an oversized lockfile is skipped before it is read — and a
    // truncated body is never parsed, since a prefix parses as nothing.
    const sizeOut = await exec(
      `cd /workspace/target-repo && git cat-file -s ${shellQuote(`${ref}:${path}`)}`
    );
    const size = Number(sizeOut.stdout.trim());
    if (!Number.isFinite(size) || size > LOCKFILE_MAX_BYTES) {
      logWarn('registry allowlist: skipping oversized lockfile', { path, ref, size });
      continue;
    }
    const show = await exec(
      `cd /workspace/target-repo && git show ${shellQuote(`${ref}:${path}`)}`,
      LOCKFILE_MAX_BYTES + 1
    );
    if (Buffer.byteLength(show.stdout) > LOCKFILE_MAX_BYTES) {
      logWarn('registry allowlist: truncated lockfile read, skipping', { path, ref });
      continue;
    }
    try {
      for (const [name, versions] of buildAllowlist(parseLockfile(path, show.stdout))) {
        const set = combined.get(name) ?? new Set<string>();
        for (const v of versions) {
          set.add(v);
        }
        combined.set(name, set);
      }
    } catch (err) {
      // Fail closed for this file: a lockfile that cannot be parsed simply
      // contributes nothing.
      logWarn('registry allowlist: unparsable lockfile, ignoring', {
        error: err instanceof Error ? err.message : String(err),
        path,
        ref,
      });
    }
  }
  for (const r of access.registries) {
    map.set(r.id, r.accessMode === 'open' ? null : combined);
  }
  return map;
}
