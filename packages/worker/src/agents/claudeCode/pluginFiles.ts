import {
  AutoRunSourceError,
  stripAutoRunSources,
  unsafeProfilePath,
} from '@auto-swe/shared/lib/harnessProfile';
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

/**
 * The files of the snapshot that are written into the container. With hooks on
 * it is the snapshot itself. With hooks off (`HarnessProfile.hooksEnabled`),
 * every auto-run command source is left out of each plugin
 * (`stripAutoRunSources`, shared with the gateway's diff and the scanner):
 * `hooks/hooks.json`, `monitors/monitors.json`, `.lsp.json`, the hooks, monitors
 * and LSP keys of `plugin.json` (the manifest is written again without them),
 * any file `plugin.json` names there, and the `hooks` frontmatter key of every
 * skill and command (the file is written again, body unchanged). Scripts and
 * executables are still written. The snapshot and its content hash are never
 * altered.
 *
 * A source that cannot be left out reliably (a path that leaves the plugin
 * folder, a missing or non-JSON named file, an unparseable `plugin.json` or
 * frontmatter, an unsafe plugin path) refuses the plugin: non-retryable
 * `PROFILE_HOOKS_UNREADABLE`.
 */
export function filesToMaterialize(
  profile: ResolvedHarnessProfile
): ResolvedHarnessProfile['files'] {
  if (profile.hooksEnabled !== false) {
    return profile.files;
  }
  try {
    return stripAutoRunSources(profile.files, profile.manifest);
  } catch (err) {
    if (err instanceof AutoRunSourceError) {
      throw hooksUnreadable(profile, err.reason);
    }
    throw err;
  }
}
