import { createHash } from 'node:crypto';
import { safeDisplayPath } from '../skillSource/display.js';
import { manifestIssues, type ProfileManifest, ProfileManifestSchema } from './manifest.js';
import { collisionKey, unsafeProfilePath } from './paths.js';
import {
  MAX_INSTRUCTIONS_BYTES,
  PROFILE_LIMITS,
  type ProfileFile,
  type ProfileFileEntry,
} from './types.js';

export const MANIFEST_PATH = 'profile.json';
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';
const SCRIPT_EXTENSIONS = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl)$/i;
const MAX_LISTED = 5;

export interface ValidatedProfile {
  manifest: ProfileManifest;
  /** Plugin directories, normalised, in manifest order. */
  pluginDirs: string[];
  /** Everything an admin should read before approving; none of it blocks. */
  warnings: string[];
  fileIndex: ProfileFileEntry[];
  totalBytes: number;
  contentHash: string;
}

export type ProfileValidation = ({ ok: true } & ValidatedProfile) | { ok: false; errors: string[] };

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

const codepointCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with object keys sorted at every depth, so equal manifests hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort(codepointCompare)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The identity of a snapshot: sha256 over the sorted (path, mode, sha256(content)) list plus the
 * parsed manifest. Independent of the order the files arrive in.
 */
export function computeContentHash(
  files: readonly ProfileFile[],
  manifest: ProfileManifest
): string {
  const listing = [...files]
    .sort((a, b) => codepointCompare(a.path, b.path))
    .map((f) => [f.path, f.mode, sha256(f.bytes)]);
  return sha256(canonicalJson({ files: listing, manifest }));
}

/**
 * Identity of a warning list: sha256 over the sorted, de-duplicated warnings. An approval that
 * names it is bound to exactly the warnings the admin saw, not to "whatever they are now".
 */
export function warningsHash(warnings: readonly string[]): string {
  return sha256(canonicalJson([...new Set(warnings)].sort(codepointCompare)));
}

/** `scripts/` content, or a file in a language a hook or command can run. */
export const isScriptPath = (rel: string) =>
  rel.split('/').includes('scripts') || SCRIPT_EXTENSIONS.test(rel);

/** A manifest path (plugin dir, instructions file) in its normalised spelling; null when unsafe. */
function manifestPath(raw: string): string | null {
  return unsafeProfilePath(raw) === null ? raw : null;
}

function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function listed(paths: string[]): string {
  const shown = paths.slice(0, MAX_LISTED).map(safeDisplayPath).join(', ');
  return paths.length > MAX_LISTED ? `${shown} and ${paths.length - MAX_LISTED} more` : shown;
}

/**
 * Check a profile folder's files (paths relative to the folder) against the v1 contract and work
 * out its identity. Pure: nothing is read from a network or executed. Every refusal is a fixed
 * sentence that may name a (display-safe) path, never repository text.
 */
export function validateProfile(files: readonly ProfileFile[]): ProfileValidation {
  const errors: string[] = [];

  if (files.length > PROFILE_LIMITS.maxFiles) {
    errors.push(`the folder holds more than ${PROFILE_LIMITS.maxFiles} files`);
  }
  const seen = new Map<string, string>();
  let totalBytes = 0;
  for (const f of files) {
    const bad = unsafeProfilePath(f.path);
    if (bad) {
      errors.push(`unsafe path ${safeDisplayPath(f.path)}: ${bad}`);
      continue;
    }
    const key = collisionKey(f.path);
    if (seen.has(key)) {
      errors.push(`duplicate path after normalisation: ${safeDisplayPath(f.path)}`);
    }
    seen.set(key, f.path);
    if (f.bytes.length > PROFILE_LIMITS.maxFileBytes) {
      errors.push(`${safeDisplayPath(f.path)} exceeds ${PROFILE_LIMITS.maxFileBytes} bytes`);
    }
    totalBytes += f.bytes.length;
  }
  if (totalBytes > PROFILE_LIMITS.maxTotalBytes) {
    errors.push(`the folder exceeds ${PROFILE_LIMITS.maxTotalBytes} bytes in total`);
  }
  if (errors.length > 0) {
    return { errors, ok: false };
  }

  const byPath = new Map(files.map((f) => [f.path, f]));
  const manifestFile = byPath.get(MANIFEST_PATH);
  if (!manifestFile) {
    return { errors: ['profile.json not found in the folder'], ok: false };
  }
  const text = utf8(manifestFile.bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? '');
  } catch {
    return { errors: ['profile.json is not valid UTF-8 JSON'], ok: false };
  }
  const parsed = ProfileManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return { errors: manifestIssues(parsed.error), ok: false };
  }
  const manifest = parsed.data;

  if (manifest.instructions !== undefined) {
    const rel = manifestPath(manifest.instructions);
    const file = rel === null ? undefined : byPath.get(rel);
    if (rel === null || !/\.md$/i.test(rel)) {
      errors.push('profile.json instructions must be a relative .md path');
    } else if (!file) {
      errors.push(`instructions file ${safeDisplayPath(rel)} not found`);
    } else if (file.bytes.length > MAX_INSTRUCTIONS_BYTES) {
      errors.push(`instructions file exceeds ${MAX_INSTRUCTIONS_BYTES} bytes`);
    } else if (utf8(file.bytes) === null) {
      errors.push('instructions file is not valid UTF-8 text');
    }
  }

  const pluginDirs: string[] = [];
  for (const dir of manifest.plugins ?? []) {
    const rel = manifestPath(dir.replace(/\/+$/, ''));
    if (rel === null) {
      errors.push(`plugin path ${safeDisplayPath(dir)} is not a safe relative directory`);
      continue;
    }
    if (pluginDirs.includes(rel)) {
      errors.push(`plugin ${safeDisplayPath(rel)} is listed twice`);
      continue;
    }
    const pluginJson = byPath.get(`${rel}/${PLUGIN_MANIFEST}`);
    if (!pluginJson) {
      errors.push(`plugin ${safeDisplayPath(rel)} has no ${PLUGIN_MANIFEST}`);
      continue;
    }
    try {
      const doc = JSON.parse(utf8(pluginJson.bytes) ?? '');
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
        throw new Error('not an object');
      }
    } catch {
      errors.push(`plugin ${safeDisplayPath(rel)}: ${PLUGIN_MANIFEST} is not a valid JSON object`);
      continue;
    }
    pluginDirs.push(rel);
  }
  if (errors.length > 0) {
    return { errors, ok: false };
  }

  const warnings = profileWarnings(files, manifest, pluginDirs);
  const fileIndex = [...files]
    .sort((a, b) => codepointCompare(a.path, b.path))
    .map((f) => ({ mode: f.mode, path: f.path, size: f.bytes.length }));
  return {
    contentHash: computeContentHash(files, manifest),
    fileIndex,
    manifest,
    ok: true,
    pluginDirs,
    totalBytes,
    warnings,
  };
}

function profileWarnings(
  files: readonly ProfileFile[],
  manifest: ProfileManifest,
  pluginDirs: string[]
): string[] {
  const warnings: string[] = [];
  const inPlugin = (p: string) => pluginDirs.some((d) => p.startsWith(`${d}/`));
  const pluginFiles = files.filter((f) => inPlugin(f.path));

  const mcp = pluginFiles.filter((f) => f.path.split('/').pop() === '.mcp.json');
  if (mcp.length > 0) {
    warnings.push(
      `plugin MCP servers are stored but ignored at run time (${listed(mcp.map((f) => f.path))})`
    );
  }
  const hooks = pluginFiles.filter(
    (f) => f.path.endsWith('/hooks/hooks.json') || f.path.endsWith(`/${PLUGIN_MANIFEST}`)
  );
  const hookFiles = hooks.filter((f) => {
    if (f.path.endsWith('/hooks/hooks.json')) {
      return true;
    }
    try {
      return 'hooks' in (JSON.parse(utf8(f.bytes) ?? '') as object);
    } catch {
      return false;
    }
  });
  if (hookFiles.length > 0) {
    warnings.push(
      `hooks run commands inside the run container (${listed(hookFiles.map((f) => f.path))})`
    );
  }
  const scripts = pluginFiles.filter((f) => isScriptPath(f.path));
  if (scripts.length > 0) {
    warnings.push(`scripts are present (${listed(scripts.map((f) => f.path))})`);
  }
  const executable = files.filter((f) => f.mode === '100755');
  if (executable.length > 0) {
    warnings.push(`files with the executable bit set (${listed(executable.map((f) => f.path))})`);
  }
  const used = new Set([MANIFEST_PATH, manifest.instructions]);
  const unused = files.filter((f) => !used.has(f.path) && !inPlugin(f.path));
  if (unused.length > 0) {
    warnings.push(
      `files outside the instructions and plugins are stored but never used (${listed(unused.map((f) => f.path))})`
    );
  }
  return warnings;
}
