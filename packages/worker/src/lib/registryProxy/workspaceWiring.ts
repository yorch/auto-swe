/**
 * Wiring between `createWorkspace` and the registry proxy: resolve which
 * registries a team's workspace may use, register it, and produce everything
 * the container side needs — env for `docker run`, the npmrc, the Berry rc —
 * while the credential itself never leaves the worker.
 */
import { prisma } from '@auto-swe/shared/db';
import { decryptSecret } from '@auto-swe/shared/lib/crypto';
import {
  buildGoAllowlist,
  GO_SUM_NAME,
  GO_WORK_SUM_NAME,
  parseGoSum,
} from '@auto-swe/shared/lib/goModuleAllowlist';
import {
  buildAllowlist,
  LOCKFILE_NAMES,
  packageManagerPins,
  parseLockfile,
} from '@auto-swe/shared/lib/lockfileAllowlist';
import { registriesFor, resolvePackageRegistries } from '@auto-swe/shared/lib/packageRegistry';
import {
  buildPypiAllowlist,
  isPypiLockfileName,
  parsePypiLockfile,
} from '@auto-swe/shared/lib/pypiAllowlist';
import { logWarn } from '../activityLog.js';
import { shellQuote } from '../shellQuote.js';

export {
  registryWorkspaceEnv,
  renderNpmrc,
  renderYarnrc,
  splitRegistryWorkspaceEnv,
} from './render.js';

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
    ecosystem: 'npm' | 'go' | 'pypi';
    id: string;
    isDefault: boolean;
    name: string;
    scopes: string[];
  }[];
  registration: RegistryRegistration;
}

type RegistryRow = Awaited<ReturnType<typeof prisma.packageRegistry.findMany>>[number];

function toResolvedRegistry(
  registry: RegistryRow,
  ecosystem: 'npm' | 'go' | 'pypi',
  isDefault: boolean,
  scopes: string[]
): ResolvedRegistry {
  return {
    allowPrivateNetwork: registry.allowPrivateNetwork,
    authKind: registry.authKind === 'basic' ? 'basic' : 'bearer',
    ecosystem,
    id: registry.id,
    isDefault,
    name: registry.name,
    scopes,
    token: registry.tokenCiphertext
      ? decryptSecret({
          authTag: registry.tokenAuthTag as Buffer,
          ciphertext: registry.tokenCiphertext,
          keyVersion: registry.tokenKeyVersion as number,
          nonce: registry.tokenNonce as Buffer,
        })
      : null,
    upstreamUrl: registry.upstreamUrl,
  };
}

/**
 * Resolve and register this workspace's registries, or `null` when no wiring
 * applies (proxy off, no team given, or no registry of a wired ecosystem
 * resolves). The registration stays in its not-ready 503 state until the
 * caller sets the allowlist.
 *
 * npm is always resolved. Go is resolved only when `wanted.go` is set — the
 * caller's say-so that the repository's stack uses it, so a Node repository
 * never receives a Go proxy it has no use for. PyPI is the same, behind `wanted.pypi`.
 */
export async function beginWorkspaceRegistries(
  teamId: string | null,
  containerName: string,
  wanted: { go?: boolean; pypi?: boolean } = {}
): Promise<WorkspaceRegistryAccess | null> {
  const proxy = workerRegistryProxy();
  if (!proxy || !teamId) {
    return null;
  }
  const rows = await prisma.packageRegistry.findMany({
    where: { isActive: true, OR: [{ teamId }, { teamId: null }] },
  });
  // The query returns every ecosystem's rows. Each ecosystem resolves from its own rows only,
  // so a go row can never be taken for an npm registry (nor shadow one).
  const resolved = resolvePackageRegistries(registriesFor(rows, 'npm'), teamId);
  // A go row has no scopes, so at most one default comes out; keep only that.
  const resolvedGo = wanted.go
    ? resolvePackageRegistries(registriesFor(rows, 'go'), teamId).filter((r) => r.isDefault)
    : [];
  const resolvedPypi = wanted.pypi
    ? resolvePackageRegistries(registriesFor(rows, 'pypi'), teamId).filter((r) => r.isDefault)
    : [];
  if (resolved.length === 0 && resolvedGo.length === 0 && resolvedPypi.length === 0) {
    return null;
  }
  const registries: ResolvedRegistry[] = [
    ...resolved.map(({ isDefault, registry, scopes }) =>
      toResolvedRegistry(registry, 'npm', isDefault, scopes)
    ),
    ...resolvedGo.map(({ registry }) => toResolvedRegistry(registry, 'go', true, [])),
    ...resolvedPypi.map(({ registry }) => toResolvedRegistry(registry, 'pypi', true, [])),
  ];
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
  const regView: WorkspaceRegistryAccess['registries'] = [
    ...resolved.map(({ isDefault, registry, scopes }) => ({
      accessMode: registry.accessMode,
      ecosystem: 'npm' as const,
      id: registry.id,
      isDefault,
      name: registry.name,
      scopes,
    })),
    ...resolvedGo.map(({ registry }) => ({
      accessMode: registry.accessMode,
      ecosystem: 'go' as const,
      id: registry.id,
      isDefault: true,
      name: registry.name,
      scopes: [],
    })),
    ...resolvedPypi.map(({ registry }) => ({
      accessMode: registry.accessMode,
      ecosystem: 'pypi' as const,
      id: registry.id,
      isDefault: true,
      name: registry.name,
      scopes: [],
    })),
  ];
  return {
    baseUrl: registration.baseUrl,
    env: registryWorkspaceEnv(regView, registration.baseUrl, registration.token),
    registration,
    registries: regView,
    token: registration.token,
  };
}

type Exec = (command: string, maxOutputBytes?: number) => Promise<{ stdout: string }>;

/**
 * One file as committed at `ref`, or why it was not read. Size first: an
 * oversized file is skipped before it is read — and a truncated body is never
 * parsed, since a prefix parses as nothing.
 */
async function readCommittedFile(
  exec: Exec,
  repoDir: string,
  ref: string,
  path: string
): Promise<{ text: string } | { size?: number; skipped: 'oversized' | 'truncated' }> {
  const sizeOut = await exec(`cd ${repoDir} && git cat-file -s ${shellQuote(`${ref}:${path}`)}`);
  const size = Number(sizeOut.stdout.trim());
  if (!Number.isFinite(size) || size > LOCKFILE_MAX_BYTES) {
    return { size, skipped: 'oversized' };
  }
  const show = await exec(
    `cd ${repoDir} && git show ${shellQuote(`${ref}:${path}`)}`,
    LOCKFILE_MAX_BYTES + 1
  );
  if (Buffer.byteLength(show.stdout) > LOCKFILE_MAX_BYTES) {
    return { skipped: 'truncated' };
  }
  return { text: show.stdout };
}

/**
 * The allowlist derived from every `go.sum` committed at `ref`, at any depth.
 * Always a map — empty when the repository has none, so a lockfile-mode Go
 * registry then denies everything instead of being left unchecked. A file that
 * is oversized, truncated or unparsable contributes nothing (fails closed).
 */
async function buildGoSumAllowlist(
  exec: Exec,
  repoDir: string,
  ref: string,
  allPaths: string[]
): Promise<Map<string, Set<string>>> {
  const combined = new Map<string, Set<string>>();
  const all = allPaths.filter((p) => {
    const name = p.split('/').pop();
    return name === GO_SUM_NAME || name === GO_WORK_SUM_NAME;
  });
  if (all.length > LOCKFILE_MAX_FILES) {
    logWarn('registry allowlist: more go.sum files than the cap, keeping the first', {
      count: all.length,
      ref,
    });
  }
  for (const path of all.slice(0, LOCKFILE_MAX_FILES)) {
    const read = await readCommittedFile(exec, repoDir, ref, path);
    if ('skipped' in read) {
      logWarn(`registry allowlist: ${read.skipped} go.sum, skipping`, {
        path,
        ref,
        ...(read.size !== undefined ? { size: read.size } : {}),
      });
      continue;
    }
    try {
      for (const [module, versions] of buildGoAllowlist(parseGoSum(read.text))) {
        const set = combined.get(module) ?? new Set<string>();
        for (const v of versions) {
          set.add(v);
        }
        combined.set(module, set);
      }
    } catch (err) {
      logWarn('registry allowlist: unparsable go.sum, ignoring', {
        error: err instanceof Error ? err.message : String(err),
        path,
        ref,
      });
    }
  }
  return combined;
}

/** Trees whose `requirements.txt` files belong to a dependency, not to the repository. */
const PYPI_SKIP_SEGMENTS = new Set([
  '.git',
  '.venv',
  'node_modules',
  'site-packages',
  'third_party',
  'vendor',
  'venv',
]);

/**
 * The allowlist derived from every PyPI lockfile committed at `ref`, at any depth outside
 * vendored and virtualenv trees. Always a map — empty when there is none, so a lockfile-mode
 * PyPI registry then denies everything. A file that is oversized, truncated or unparsable
 * contributes nothing (fails closed).
 */
async function buildPypiLockAllowlist(
  exec: Exec,
  repoDir: string,
  ref: string,
  allPaths: string[]
): Promise<Map<string, Set<string>>> {
  const combined = new Map<string, Set<string>>();
  const all = allPaths.filter((p) => {
    const segments = p.split('/');
    return (
      isPypiLockfileName(segments[segments.length - 1] ?? '') &&
      !segments.slice(0, -1).some((s) => PYPI_SKIP_SEGMENTS.has(s))
    );
  });
  if (all.length > LOCKFILE_MAX_FILES) {
    logWarn('registry allowlist: more PyPI lockfiles than the cap, keeping the first', {
      count: all.length,
      ref,
    });
  }
  for (const path of all.slice(0, LOCKFILE_MAX_FILES)) {
    const read = await readCommittedFile(exec, repoDir, ref, path);
    if ('skipped' in read) {
      logWarn(`registry allowlist: ${read.skipped} PyPI lockfile, skipping`, {
        path,
        ref,
        ...(read.size !== undefined ? { size: read.size } : {}),
      });
      continue;
    }
    try {
      for (const [name, versions] of buildPypiAllowlist(parsePypiLockfile(path, read.text))) {
        const set = combined.get(name) ?? new Set<string>();
        for (const v of versions) {
          set.add(v);
        }
        combined.set(name, set);
      }
    } catch (err) {
      logWarn('registry allowlist: unparsable PyPI lockfile, ignoring', {
        error: err instanceof Error ? err.message : String(err),
        path,
        ref,
      });
    }
  }
  return combined;
}

/**
 * The lockfile-derived allowlist, keyed by registry id. An `open`-mode
 * registry maps to `null` (no check); a lockfile-mode one maps to the union
 * of every parsed lockfile — including an empty set when the repo has none.
 * npm registries are fed by npm lockfiles only, Go registries by `go.sum`
 * only and PyPI registries by PyPI lockfiles only. `exec` runs `sh -c` in the workspace and returns stdout.
 */
export async function buildRegistryAllowlist(
  access: WorkspaceRegistryAccess,
  ref: string,
  exec: Exec,
  repoDir = '/workspace/target-repo'
): Promise<Map<string, Map<string, Set<string>> | null>> {
  const map = new Map<string, Map<string, Set<string>> | null>();
  const combined = new Map<string, Set<string>>();
  const listOut = await exec(`cd ${repoDir} && git ls-tree -r --name-only -z ${shellQuote(ref)}`);
  const allPaths = listOut.stdout.split('\0').filter(Boolean);
  const all = allPaths.filter((p) => LOCKFILE_NAMES.has(p.split('/').pop() ?? ''));
  if (all.length > LOCKFILE_MAX_FILES) {
    logWarn('registry allowlist: more lockfiles than the cap, keeping the first', {
      count: all.length,
      ref,
    });
  }
  const paths = all.slice(0, LOCKFILE_MAX_FILES);
  for (const path of paths) {
    const read = await readCommittedFile(exec, repoDir, ref, path);
    if ('skipped' in read) {
      if (read.skipped === 'oversized') {
        logWarn('registry allowlist: skipping oversized lockfile', {
          path,
          ref,
          size: read.size,
        });
      } else {
        logWarn('registry allowlist: truncated lockfile read, skipping', { path, ref });
      }
      continue;
    }
    try {
      for (const [name, versions] of buildAllowlist(parseLockfile(path, read.text))) {
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
  // Corepack pins: package.json files at the root or in a directory that holds
  // one of the lockfiles found above get their packageManager field added to
  // the allowlist, so the proxy can serve the pinned package-manager binaries.
  const lockfileDirs = new Set(
    all.map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''))
  );
  const manifestPaths = allPaths.filter(
    (p) =>
      p.split('/').pop() === 'package.json' &&
      lockfileDirs.has(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
  );
  for (const path of manifestPaths) {
    const read = await readCommittedFile(exec, repoDir, ref, path);
    if ('skipped' in read) {
      continue;
    }
    for (const pin of packageManagerPins(read.text)) {
      const set = combined.get(pin.name) ?? new Set<string>();
      set.add(pin.version);
      combined.set(pin.name, set);
    }
  }
  // Only read when a lockfile-mode Go registry will use it.
  const goRegistries = access.registries.filter((r) => r.ecosystem === 'go');
  const goCombined = goRegistries.some((r) => r.accessMode !== 'open')
    ? await buildGoSumAllowlist(exec, repoDir, ref, allPaths)
    : null;
  const pypiCombined = access.registries.some(
    (r) => r.ecosystem === 'pypi' && r.accessMode !== 'open'
  )
    ? await buildPypiLockAllowlist(exec, repoDir, ref, allPaths)
    : null;
  for (const r of access.registries) {
    if (r.ecosystem === 'pypi') {
      map.set(r.id, r.accessMode === 'open' ? null : (pypiCombined ?? new Map()));
    } else if (r.ecosystem === 'go') {
      map.set(r.id, r.accessMode === 'open' ? null : (goCombined ?? new Map()));
    } else {
      map.set(r.id, r.accessMode === 'open' ? null : combined);
    }
  }
  return map;
}
