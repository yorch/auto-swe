import { unsafeProfilePath } from '@auto-swe/shared/lib/harnessProfile';
import { ApplicationFailure } from '@temporalio/activity';
import type { ResolvedHarnessProfile } from '../../lib/config/harnessProfile.js';

const PLUGIN_MANIFEST_TAIL = '.claude-plugin/plugin.json';

/** A manifest path in the spelling the snapshot stores it under; null when it is unsafe. */
export function manifestRel(raw: string): string | null {
  const rel = raw.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return unsafeProfilePath(rel) === null ? rel : null;
}

/**
 * The name each of the profile's plugins loads under: its `plugin.json` name,
 * else its directory's. Computed from the stored snapshot.
 */
export function profilePluginNames(profile: ResolvedHarnessProfile): string[] {
  const names: string[] = [];
  for (const raw of profile.manifest.plugins ?? []) {
    const rel = manifestRel(raw);
    if (rel === null) {
      continue;
    }
    let plugin = rel.split('/').at(-1) ?? rel;
    const manifest = profile.files.find((f) => f.path === `${rel}/${PLUGIN_MANIFEST_TAIL}`);
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest.bytes.toString('utf8')) as { name?: unknown };
        if (typeof parsed.name === 'string' && parsed.name !== '') {
          plugin = parsed.name;
        }
      } catch {
        /* the directory's name stands */
      }
    }
    names.push(plugin);
  }
  return names;
}

function hooksUnreadable(profile: ResolvedHarnessProfile, why: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(
    `Plugin '${profile.name}' version ${profile.version} cannot be put into the workspace with hooks switched off: ${why}. The plugin is not run.`,
    'PROFILE_HOOKS_UNREADABLE'
  );
}

/** `ref` (a plugin.json hooks path) as a path inside `dir`; null when it leaves it. */
function resolveInside(dir: string, ref: string): string | null {
  const rel = ref.replace(/^(\.\/|\$\{CLAUDE_PLUGIN_ROOT\}\/)/, '');
  return unsafeProfilePath(rel) === null ? `${dir}/${rel}` : null;
}

/**
 * The files of the snapshot that are written into the container. With hooks on
 * it is the snapshot itself. With hooks off (`HarnessProfile.hooksEnabled`),
 * every hook config is left out of each plugin: `hooks/hooks.json`, the inline
 * `hooks` of `plugin.json` (the manifest is written again without that key) and
 * any file `plugin.json` names in `hooks` (a path, or an array mixing paths and
 * inline objects). Scripts and executables are still written. The snapshot and
 * its content hash are never altered.
 *
 * A hooks path that leaves the plugin folder or names a file that is missing or
 * not valid UTF-8 JSON, and a `plugin.json` that cannot be parsed, cannot be
 * left out reliably: the plugin is refused (non-retryable `PROFILE_HOOKS_UNREADABLE`).
 */
export function filesToMaterialize(
  profile: ResolvedHarnessProfile
): ResolvedHarnessProfile['files'] {
  if (profile.hooksEnabled !== false) {
    return profile.files;
  }
  const byPath = new Map(profile.files.map((f) => [f.path, f]));
  const dropped = new Set<string>();
  const rewritten = new Map<string, Buffer>();
  for (const raw of profile.manifest.plugins ?? []) {
    const rel = manifestRel(raw);
    if (rel === null) {
      continue;
    }
    dropped.add(`${rel}/hooks/hooks.json`);
    const manifestPath = `${rel}/${PLUGIN_MANIFEST_TAIL}`;
    const manifest = byPath.get(manifestPath);
    if (!manifest) {
      throw hooksUnreadable(profile, `its ${PLUGIN_MANIFEST_TAIL} is missing from the snapshot`);
    }
    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.bytes));
    } catch {
      throw hooksUnreadable(profile, `its ${PLUGIN_MANIFEST_TAIL} is not valid JSON`);
    }
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw hooksUnreadable(profile, `its ${PLUGIN_MANIFEST_TAIL} is not a JSON object`);
    }
    if (!('hooks' in doc)) {
      continue;
    }
    const { hooks, ...rest } = doc as { hooks?: unknown };
    const entries = Array.isArray(hooks) ? hooks : [hooks];
    for (const ref of entries.filter((e): e is string => typeof e === 'string')) {
      const target = resolveInside(rel, ref);
      if (target === null) {
        throw hooksUnreadable(profile, 'a hooks path points outside the plugin folder');
      }
      const file = byPath.get(target);
      if (!file) {
        throw hooksUnreadable(profile, 'a hooks path names a file that is not in the snapshot');
      }
      try {
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
      } catch {
        throw hooksUnreadable(profile, 'a hooks file is not valid UTF-8 JSON');
      }
      dropped.add(target);
    }
    rewritten.set(manifestPath, Buffer.from(`${JSON.stringify(rest, null, 2)}\n`, 'utf8'));
  }
  return profile.files
    .filter((f) => !dropped.has(f.path))
    .map((f) => {
      const bytes = rewritten.get(f.path);
      return bytes ? { ...f, bytes } : f;
    });
}
