import { safeDisplayPath } from '../skillSource/display.js';
import type { ProfileManifest } from './manifest.js';
import { unsafeProfilePath } from './paths.js';
import { defaultScanners, type ProfileScanners, type ScanOutcome } from './scanners.js';
import type { ProfileFile } from './types.js';
import { isScriptPath } from './validate.js';

/** Marks a hooks file the scanner could not read; it still runs in the container. */
export const HOOKS_NOT_SCANNED = 'hooks-not-scanned';
export const SCAN_INCOMPLETE = 'scan-incomplete: some patterns could not be evaluated';
/** Hook commands scanned per profile; the rest are reported, not silently skipped. */
const MAX_HOOK_COMMANDS = 200;

function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Every string under a `command` key, at any depth. */
function hookCommands(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) {
      hookCommands(v, out);
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'command' && typeof v === 'string') {
        out.push(v);
      } else {
        hookCommands(v, out);
      }
    }
  }
  return out;
}

/**
 * Advisory scan of what a profile would put in front of a model or run in the container: the
 * instructions and every plugin `.md` (text scanner), every hook command and script (shell
 * scanner). Nothing is executed. Returns warnings; an empty list means every rule ran over
 * everything. `pluginDirs` are the validated plugin directories.
 */
export async function scanProfile(
  files: readonly ProfileFile[],
  manifest: ProfileManifest,
  pluginDirs: readonly string[],
  scanners: ProfileScanners = defaultScanners
): Promise<string[]> {
  const warnings: string[] = [];
  const inPlugin = (p: string) => pluginDirs.some((d) => p.startsWith(`${d}/`));
  const report = (label: string, kind: string, out: ScanOutcome) => {
    for (const hit of out.hits) {
      warnings.push(`${safeDisplayPath(label)}: ${kind} pattern ${safeDisplayPath(hit)}`);
    }
    if (out.incomplete) {
      warnings.push(`${safeDisplayPath(label)}: ${SCAN_INCOMPLETE}`);
    }
  };

  const proseFiles = files.filter(
    (f) => f.path === manifest.instructions || (inPlugin(f.path) && /\.md$/i.test(f.path))
  );
  for (const f of proseFiles) {
    const text = utf8(f.bytes);
    if (text === null) {
      warnings.push(`${safeDisplayPath(f.path)}: not valid UTF-8 text, not scanned`);
      continue;
    }
    report(f.path, 'text', await scanners.text(text));
  }

  let commands = 0;
  const byPath = new Map(files.map((f) => [f.path, f]));
  /** Scan the commands of one parsed hooks document; false once the per-profile cap is hit. */
  const scanHookCommands = async (label: string, doc: unknown): Promise<void> => {
    for (const command of hookCommands(doc)) {
      if (++commands > MAX_HOOK_COMMANDS) {
        warnings.push(
          `${safeDisplayPath(label)}: hook commands beyond ${MAX_HOOK_COMMANDS} not scanned`
        );
        break;
      }
      report(`${label} (hook command)`, 'shell', await scanners.shell(command));
    }
  };
  const notScanned = (label: string, reason: string) =>
    warnings.push(`${safeDisplayPath(label)}: ${HOOKS_NOT_SCANNED}: ${reason}`);
  const hookDocScanned = new Set<string>();

  for (const f of files.filter((x) => inPlugin(x.path))) {
    const isPluginJson = f.path.endsWith('/.claude-plugin/plugin.json');
    const isHooksJson = f.path.endsWith('/hooks/hooks.json') || isPluginJson;
    if (!isHooksJson && !isScriptPath(f.path) && f.mode !== '100755' && !hasShebang(f.bytes)) {
      continue;
    }
    const text = utf8(f.bytes);
    if (text === null) {
      warnings.push(`${safeDisplayPath(f.path)}: binary content, not scanned`);
      continue;
    }
    if (!isHooksJson) {
      report(f.path, 'shell', await scanners.shell(text));
      continue;
    }
    if (hookDocScanned.has(f.path)) {
      continue;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      warnings.push(`${safeDisplayPath(f.path)}: not valid JSON, hook commands not scanned`);
      continue;
    }
    hookDocScanned.add(f.path);
    if (!isPluginJson) {
      await scanHookCommands(f.path, doc);
      continue;
    }
    // plugin.json declares hooks inline under `hooks`, or names hook files by path (a string or
    // an array mixing paths and inline objects); nothing else in it is a command.
    const hooks = (doc as { hooks?: unknown } | null)?.hooks;
    const pluginDir = f.path.slice(0, -'/.claude-plugin/plugin.json'.length);
    const entries = Array.isArray(hooks) ? hooks : [hooks];
    const inline = entries.filter((e) => typeof e !== 'string');
    await scanHookCommands(f.path, inline);
    for (const ref of entries.filter((e): e is string => typeof e === 'string')) {
      const target = resolveInside(pluginDir, ref);
      if (target === null) {
        notScanned(f.path, 'a hooks path points outside the plugin folder');
        continue;
      }
      const file = byPath.get(target);
      if (!file) {
        notScanned(f.path, `hooks file ${safeDisplayPath(target)} is missing`);
        continue;
      }
      if (hookDocScanned.has(target)) {
        continue;
      }
      const refText = utf8(file.bytes);
      let refDoc: unknown;
      try {
        refDoc = JSON.parse(refText ?? '');
      } catch {
        notScanned(target, 'the hooks file is not valid UTF-8 JSON');
        continue;
      }
      hookDocScanned.add(target);
      await scanHookCommands(target, refDoc);
    }
  }
  return [...new Set(warnings)];
}

/** A file that opens with `#!` is run as a script whatever it is called. */
const hasShebang = (bytes: Buffer) => bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21;

/** `ref` (a plugin.json path, usually `./hooks/x.json`) as a path inside `dir`; null when it leaves it. */
function resolveInside(dir: string, ref: string): string | null {
  const rel = ref.replace(/^(\.\/|\$\{CLAUDE_PLUGIN_ROOT\}\/)/, '');
  return unsafeProfilePath(rel) === null ? `${dir}/${rel}` : null;
}
