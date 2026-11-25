import {
  autoRunSourcesOf,
  declaredPluginMcpServers,
  MANIFEST_PATH,
  type ProfileFile,
  type ProfileManifest,
  packFiles,
  readProfileFolder,
  scanProfile,
  validateProfile,
} from '@auto-swe/shared/lib/harnessProfile';
import {
  entryFolder,
  type MarketplaceEntry,
  mcpWarnings,
  type PluginMcpServer,
} from '@auto-swe/shared/lib/marketplace';
import { SkillSourceError, type SourceLocation } from '@auto-swe/shared/lib/skillSource';
import type { HarnessProfilePreview } from '@auto-swe/shared/types/api';
import {
  HarnessProfileInvalid,
  type ProfileReadDeps,
  previewOf,
  type ReadProfile,
} from './harnessProfileService.js';

/**
 * Reading one marketplace entry as a harness profile.
 *
 * A marketplace entry is a Claude Code plugin folder, not a profile folder (no `profile.json`). It
 * is read with the same folder reader a profile uses (one request per file, same limits, same
 * refusals), then wrapped into a single-plugin profile: the files move under `plugins/<name>/` and
 * a synthesized `profile.json` names the entry, so the stored snapshot validates, hashes, scans and
 * materialises exactly like any other profile. Nothing is executed and nothing is stored here.
 *
 * MCP: the harness ignores a plugin's `.mcp.json` (`skipMcpDiscovery`, strict MCP configuration).
 * The HTTP servers it declares are surfaced as declared dependencies in the preview, with a warning
 * that an administrator must point the agent's existing `mcpConnectionId` at a matching `mcp`
 * Connection; stdio servers are flagged unsupported. There is no mapping table and no run-time
 * effect.
 */

/** A declared server as the preview lists it; `duplicate` is set when another plugin declares the name. */
export type PreviewMcpServer = PluginMcpServer & { duplicate: boolean };

export interface EntryProfileRead extends ReadProfile {
  mcpServers: PreviewMcpServer[];
  hasHooks: boolean;
  /** Profile paths of files made here rather than read from the plugin folder. */
  synthesizedFiles: string[];
}

/** Where a plugin's own manifest lives inside its folder. */
export const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

/** The profile name a plugin entry is installed under (already a valid profile name). */
const pluginDir = (name: string) => `plugins/${name}`;

/** Whether the plugin has any auto-run command source (hooks, frontmatter hooks, monitors, LSP). */
function hasHooks(files: readonly ProfileFile[], dir: string): boolean {
  return autoRunSourcesOf(files, { plugins: [dir] }).length > 0;
}

/**
 * Read an installable entry at an exact commit, validate and scan it.
 *
 * `sha` handling:
 * - a relative entry is read at the marketplace commit, and a `sha` that differs is `SHA_MOVED`;
 * - a GitHub entry that names a commit is read at it, and a different `sha` is `SHA_MOVED`;
 * - a GitHub entry that names only a ref is resolved now; with `bind` and a `sha` the ref must
 *   still resolve to it (`SHA_MOVED`), without `bind` a `sha` reads exactly that commit.
 */
export async function readEntryProfile(
  input: {
    marketplace: SourceLocation;
    marketplaceSha: string;
    entry: MarketplaceEntry;
    sha?: string;
    bind: boolean;
  },
  deps: ProfileReadDeps = {}
): Promise<EntryProfileRead> {
  const { entry } = input;
  const name = entry.name as string;
  const folder = entryFolder(input.marketplace, entry, input.marketplaceSha);
  let opts: { atSha?: string; expectSha?: string };
  if (folder.fixedSha !== null) {
    if (input.sha !== undefined && input.sha !== folder.fixedSha) {
      throw new SkillSourceError('SHA_MOVED');
    }
    opts = { atSha: folder.fixedSha };
  } else if (input.sha !== undefined) {
    opts = input.bind ? { expectSha: input.sha } : { atSha: input.sha };
  } else {
    opts = {};
  }
  return synthesizeEntryProfile(
    folder.location,
    name,
    entry.description?.trim() || `Marketplace plugin ${name}`,
    opts,
    deps,
    entry.pluginManifest
  );
}

/**
 * Read a plugin folder at a location and wrap it as a single-plugin profile (`profile.json` plus
 * the folder under `plugins/<name>/`). Shared by approving an entry and by re-reading a
 * marketplace-bound profile whose stored source is that plugin folder.
 */
export async function synthesizeEntryProfile(
  location: SourceLocation,
  name: string,
  description: string,
  opts: { atSha?: string; expectSha?: string },
  deps: ProfileReadDeps = {},
  pluginManifest:
    | Record<string, unknown>
    | null
    | (() => Promise<Record<string, unknown> | null>) = null
): Promise<EntryProfileRead> {
  const read = await readProfileFolder(location, opts, deps.source);
  if (read.problems.length > 0) {
    throw new HarnessProfileInvalid(read.problems);
  }
  const dir = pluginDir(name);
  // A `strict: false` entry is its plugin's manifest: when the folder has no `plugin.json` of its
  // own, the entry's fields become one. A `plugin.json` in the folder always wins. The file is
  // made before validation, so it is hashed, scanned, previewed and stored like any other.
  const synthesizedFiles: string[] = [];
  const folderFiles = [...read.files];
  const synthesized = folderFiles.some((f) => f.path === PLUGIN_MANIFEST)
    ? null
    : typeof pluginManifest === 'function'
      ? await pluginManifest()
      : pluginManifest;
  if (synthesized !== null) {
    folderFiles.push({
      bytes: Buffer.from(JSON.stringify(synthesized)),
      mode: '100644',
      path: PLUGIN_MANIFEST,
    });
    synthesizedFiles.push(`${dir}/${PLUGIN_MANIFEST}`);
  }
  const manifest: ProfileManifest = {
    description,
    name,
    plugins: [dir],
  };
  const files: ProfileFile[] = [
    {
      bytes: Buffer.from(JSON.stringify(manifest)),
      mode: '100644',
      path: MANIFEST_PATH,
    },
    ...folderFiles.map((f) => ({ ...f, path: `${dir}/${f.path}` })),
  ];
  const validation = validateProfile(files);
  if (!validation.ok) {
    throw new HarnessProfileInvalid(validation.errors);
  }
  const scan = await scanProfile(files, validation.manifest, validation.pluginDirs, deps.scanners);
  // `.mcp.json` and the inline `mcpServers` of plugin.json (a synthesized one included), read by
  // the one parser the mapping feature uses.
  const mcpServers: PreviewMcpServer[] = declaredPluginMcpServers(
    files,
    validation.manifest
  ).servers.map((s) => ({
    duplicate: s.duplicate,
    name: s.name,
    supported: s.supported,
    transport: s.transport,
    url: s.url,
  }));
  return {
    files,
    hasHooks: hasHooks(files, dir),
    location,
    mcpServers,
    sha: read.sha,
    synthesizedFiles,
    validated: validation,
    warnings: [...validation.warnings, ...scan, ...mcpWarnings(mcpServers)],
  };
}

export type EntryPreview = HarnessProfilePreview & {
  mcpServers: PluginMcpServer[];
  hasHooks: boolean;
  /** Profile paths of files the server made from the entry's own fields (listed in `files` too). */
  synthesizedFiles: string[];
};

export function entryPreviewOf(
  read: EntryProfileRead,
  conflicts: HarnessProfilePreview['conflicts']
): EntryPreview {
  return {
    ...previewOf(read, { conflicts, matchesVersion: null }),
    hasHooks: read.hasHooks,
    mcpServers: read.mcpServers,
    synthesizedFiles: read.synthesizedFiles,
  };
}

/** The version row a new profile starts with; shared with the profile create path's columns. */
export function firstVersionData(read: ReadProfile, approvedById: string) {
  return {
    approvedById,
    commitSha: read.sha,
    contentHash: read.validated.contentHash,
    fileCount: read.files.length,
    fileIndex: read.validated.fileIndex,
    files: new Uint8Array(packFiles(read.files)),
    manifest: read.validated.manifest,
    scanWarnings: read.warnings,
    totalBytes: read.validated.totalBytes,
    version: 1,
  };
}
