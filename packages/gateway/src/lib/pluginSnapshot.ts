import { createHash } from 'node:crypto';
import { type ProfileFile, unsafeProfilePath } from '@auto-swe/shared/lib/harnessProfile';
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

const sha256 = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');

/** Every `command` string anywhere in a hooks document. */
function commandsIn(doc: unknown, out: string[] = []): string[] {
  if (Array.isArray(doc)) {
    for (const item of doc) {
      commandsIn(item, out);
    }
  } else if (doc && typeof doc === 'object') {
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'command' && typeof value === 'string') {
        out.push(value);
      } else {
        commandsIn(value, out);
      }
    }
  }
  return out;
}

function sourceOf(path: string, bytes: Buffer): HookSource {
  let commands: string[] = [];
  try {
    commands = commandsIn(JSON.parse(decode(bytes) ?? ''));
  } catch {
    commands = [];
  }
  return { commands, digest: sha256(bytes), path };
}

/** `ref` (a plugin.json hooks path) as a path inside `dir`; null when it leaves it. */
function resolveInside(dir: string, ref: string): string | null {
  const rel = ref.replace(/^(\.\/|\$\{CLAUDE_PLUGIN_ROOT\}\/)/, '');
  return unsafeProfilePath(rel) === null ? `${dir}/${rel}` : null;
}

/**
 * The hook sources of a snapshot, by path: each plugin's `hooks/hooks.json`, the inline `hooks`
 * of its `plugin.json` (keyed `<plugin.json path>#hooks`), and every file `plugin.json` names in
 * `hooks`. A named file that is missing or leaves the plugin folder is still a source (digest of
 * the reference), so changing it shows up as a change.
 */
export function hookSourcesOf(
  files: readonly ProfileFile[],
  manifest: { plugins?: string[] } | null | undefined
): Map<string, HookSource> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out = new Map<string, HookSource>();
  for (const dir of pluginDirsOf(manifest)) {
    const hooksJson = byPath.get(`${dir}/hooks/hooks.json`);
    if (hooksJson) {
      out.set(hooksJson.path, sourceOf(hooksJson.path, hooksJson.bytes));
    }
    const pluginJsonPath = `${dir}/${PLUGIN_MANIFEST}`;
    const pluginJson = byPath.get(pluginJsonPath);
    if (!pluginJson) {
      continue;
    }
    let hooks: unknown;
    try {
      hooks = (JSON.parse(decode(pluginJson.bytes) ?? '') as { hooks?: unknown } | null)?.hooks;
    } catch {
      continue;
    }
    if (hooks === undefined) {
      continue;
    }
    const entries = Array.isArray(hooks) ? hooks : [hooks];
    const inline = entries.filter((e) => typeof e !== 'string');
    if (inline.length > 0) {
      const text = JSON.stringify(inline);
      out.set(`${pluginJsonPath}#hooks`, {
        commands: commandsIn(inline),
        digest: sha256(text),
        path: `${pluginJsonPath}#hooks`,
      });
    }
    for (const ref of entries.filter((e): e is string => typeof e === 'string')) {
      const target = resolveInside(dir, ref);
      const file = target === null ? undefined : byPath.get(target);
      if (target !== null && file) {
        out.set(target, sourceOf(target, file.bytes));
      } else {
        const label = `${pluginJsonPath}#hooks:${ref}`;
        out.set(label, { commands: [], digest: sha256(`unresolved:${ref}`), path: label });
      }
    }
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
