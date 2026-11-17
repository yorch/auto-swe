import { autoRunSourcesOf, type ProfileFile } from '@auto-swe/shared/lib/harnessProfile';
import type {
  HarnessProfileHookChanges,
  HarnessProfileHookSource,
} from '@auto-swe/shared/types/api';

/**
 * Reads an approved snapshot for the two questions the gateway asks of its files: what are the
 * plugins in it called (binding refuses a name two profiles share), and what hook files does it
 * hold (an update that changes them under a plugin with hooks on needs an acknowledgement).
 * Nothing here executes a file or writes one.
 */

const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';

const decode = (bytes: Buffer): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const normaliseDir = (dir: string) => dir.replace(/^\.\//, '').replace(/\/+$/, '');

/** The plugin directories a manifest lists, normalised like the validator does. */
export function pluginDirsOf(manifest: { plugins?: string[] } | null | undefined): string[] {
  return (manifest?.plugins ?? []).map(normaliseDir);
}

/**
 * The names the plugins of a snapshot answer to: `plugin.json`'s `name`, else the directory's
 * last segment (what Claude Code itself uses). Lower-cased, so two names that differ by case
 * count as one.
 */
export function pluginNamesOf(
  files: readonly ProfileFile[],
  manifest: { plugins?: string[] } | null | undefined
): string[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const names: string[] = [];
  for (const dir of pluginDirsOf(manifest)) {
    let named: unknown;
    const json = byPath.get(`${dir}/${PLUGIN_MANIFEST}`);
    if (json) {
      try {
        named = (JSON.parse(decode(json.bytes) ?? '') as { name?: unknown } | null)?.name;
      } catch {
        named = undefined;
      }
    }
    const name = typeof named === 'string' && named !== '' ? named : dir.split('/').at(-1);
    if (name) {
      names.push(name.toLowerCase());
    }
  }
  return names;
}

interface HookSource {
  path: string;
  digest: string;
  commands: string[];
}

/**
 * The auto-run command sources of a snapshot, by path (`autoRunSourcesOf`, the module the
 * worker's hook switch and the approval scanner use too): each plugin's `hooks/hooks.json`, the
 * inline `hooks` of its `plugin.json` (keyed `<plugin.json path>#hooks`) and every file it names,
 * the `hooks` frontmatter of its skills and commands (`<file>.md#hooks`), its monitors and its LSP
 * servers. A named file that is missing or leaves the plugin folder is still a source, so changing
 * it shows up as a change.
 */
export function hookSourcesOf(
  files: readonly ProfileFile[],
  manifest: { plugins?: string[] } | null | undefined
): Map<string, HookSource> {
  const out = new Map<string, HookSource>();
  for (const s of autoRunSourcesOf(files, manifest)) {
    out.set(s.path, { commands: s.commands, digest: s.digest, path: s.path });
  }
  return out;
}

const bySource = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

const toDto = (s: HookSource): HarnessProfileHookSource => ({
  commands: s.commands,
  path: s.path,
});

/** What moving from `prev` to `next` does to the hook files. */
export function diffHooks(
  prev: ReadonlyMap<string, HookSource>,
  next: ReadonlyMap<string, HookSource>
): HarnessProfileHookChanges {
  const added: HarnessProfileHookSource[] = [];
  const removed: HarnessProfileHookSource[] = [];
  const changed: HarnessProfileHookChanges['changed'] = [];
  for (const [path, n] of next) {
    const p = prev.get(path);
    if (!p) {
      added.push(toDto(n));
    } else if (p.digest !== n.digest) {
      changed.push({
        addedCommands: n.commands.filter((c) => !p.commands.includes(c)),
        path,
        removedCommands: p.commands.filter((c) => !n.commands.includes(c)),
      });
    }
  }
  for (const [path, p] of prev) {
    if (!next.has(path)) {
      removed.push(toDto(p));
    }
  }
  return {
    added: added.sort(bySource),
    changed: changed.sort(bySource),
    removed: removed.sort(bySource),
  };
}

export const hasHookChanges = (c: HarnessProfileHookChanges) =>
  c.added.length + c.removed.length + c.changed.length > 0;

/** The hook diff between two snapshots. */
export function hookChangesBetween(
  prev: { files: readonly ProfileFile[]; manifest: { plugins?: string[] } },
  next: { files: readonly ProfileFile[]; manifest: { plugins?: string[] } }
): HarnessProfileHookChanges {
  return diffHooks(
    hookSourcesOf(prev.files, prev.manifest),
    hookSourcesOf(next.files, next.manifest)
  );
}
