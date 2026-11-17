import { createHash } from 'node:crypto';
import { isAlias, isMap, isScalar, type Pair, parseDocument as parseYaml, visit } from 'yaml';
import { safeDisplayPath } from '../skillSource/display.js';
import { unsafeProfilePath } from './paths.js';
import type { ProfileFile } from './types.js';

/**
 * Every "auto-run command source" of a plugin: a place where the plugin declares a command the
 * host runs without the model asking for it. One module answers three questions the same way, so
 * the hook switch cannot cover less than the diff, the preview or the scanner look at:
 *
 *  - `autoRunSourcesOf`: what are the sources, and which commands do they hold (diff, preview,
 *    scan);
 *  - `stripAutoRunSources`: the file list to write into the container when hooks are OFF.
 *
 * The kinds:
 *  - `hooks-file`: `hooks/hooks.json`;
 *  - `plugin-json-hooks`: `hooks` in `plugin.json`, inline or naming a file;
 *  - `frontmatter-hooks`: a `hooks` key in the YAML frontmatter of a skill or command `.md`, which
 *    the harness's plugin loader attaches to the command;
 *  - `monitors`: `monitors/monitors.json`, `plugin.json` `monitors` and `experimental.monitors`
 *    (background watch scripts the host arms, unsandboxed, at the trust tier of hooks);
 *  - `lsp`: `.lsp.json` and `plugin.json` `lspServers` (language servers the host launches).
 *
 * Pure and I/O free. Nothing here executes a file or alters its input.
 */

export type AutoRunKind =
  | 'hooks-file'
  | 'plugin-json-hooks'
  | 'frontmatter-hooks'
  | 'monitors'
  | 'lsp';

export interface AutoRunSource {
  /** The normalised plugin directory the source belongs to. */
  plugin: string;
  kind: AutoRunKind;
  /**
   * Stable key: the file's path, `<plugin.json>#<key>` for an inline value, `<file>.md#hooks` for
   * frontmatter, `<plugin.json>#<key>:<ref>` for a reference that cannot be followed.
   */
  path: string;
  /** The command lines it would run (a monitor or LSP server's `command` plus its `args`). */
  commands: string[];
  /** Hash of the source's content, so a change that moves no command still shows. */
  digest: string;
  /** Why the commands could not be read, as a fixed string; absent when they were. */
  unreadable?: string;
}

/** Thrown by `stripAutoRunSources` when a source cannot be left out reliably. */
export class AutoRunSourceError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AutoRunSourceError';
  }
}

const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';
const sha256 = (v: Buffer | string) => createHash('sha256').update(v).digest('hex');
const display = (p: string) => safeDisplayPath(p);

/** A manifest `plugins` entry in the spelling the snapshot stores it under; null when unsafe. */
function pluginDirOf(raw: string): string | null {
  const rel = raw.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return unsafeProfilePath(rel) === null ? rel : null;
}

/** `ref` (a path named inside plugin.json) as a path inside `dir`; null when it leaves it. */
function resolveInside(dir: string, ref: string): string | null {
  const rel = ref.replace(/^(\.\/|\$\{CLAUDE_PLUGIN_ROOT\}\/)/, '').replace(/\/+$/, '');
  return unsafeProfilePath(rel) === null ? `${dir}/${rel}` : null;
}

function utf8(bytes: Buffer, ignoreBOM = false): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM }).decode(bytes);
  } catch {
    return null;
  }
}

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = utf8(bytes);
  if (text === null) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Every command in a document: the string under any `command` key, at any depth. With `withArgs`
 * (monitors, LSP servers) a sibling `args` array is appended, since `command` alone is only the
 * program.
 */
function commandsIn(doc: unknown, withArgs: boolean, out: string[] = []): string[] {
  if (Array.isArray(doc)) {
    for (const item of doc) {
      commandsIn(item, withArgs, out);
    }
  } else if (doc && typeof doc === 'object') {
    const obj = doc as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'command' && typeof value === 'string') {
        const args = withArgs && Array.isArray(obj.args) ? obj.args : [];
        const rest = args.filter((a): a is string => typeof a === 'string');
        out.push(rest.length > 0 ? `${value} ${rest.join(' ')}` : value);
      } else {
        commandsIn(value, withArgs, out);
      }
    }
  }
  return out;
}

interface ManifestKey {
  path: readonly string[];
  kind: AutoRunKind;
  /** The label used in keys and messages. */
  label: string;
}

/** The `plugin.json` keys that declare auto-run commands (inline, or a path, or an array of both). */
const MANIFEST_KEYS: readonly ManifestKey[] = [
  { kind: 'plugin-json-hooks', label: 'hooks', path: ['hooks'] },
  { kind: 'monitors', label: 'monitors', path: ['monitors'] },
  { kind: 'monitors', label: 'experimental.monitors', path: ['experimental', 'monitors'] },
  { kind: 'lsp', label: 'lspServers', path: ['lspServers'] },
];

/** The default files a plugin loads without naming them. */
const DEFAULT_FILES: readonly { rel: string; kind: AutoRunKind }[] = [
  { kind: 'hooks-file', rel: 'hooks/hooks.json' },
  { kind: 'monitors', rel: 'monitors/monitors.json' },
  { kind: 'lsp', rel: '.lsp.json' },
];

const withArgsFor = (kind: AutoRunKind) => kind === 'monitors' || kind === 'lsp';

function valueAt(doc: unknown, path: readonly string[]): unknown {
  let cur: unknown = doc;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(key in cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** The string references and inline values of a plugin.json entry. */
function entriesOf(value: unknown): { inline: unknown[]; refs: string[] } {
  const all = Array.isArray(value) ? value : [value];
  return {
    inline: all.filter((e) => typeof e !== 'string'),
    refs: all.filter((e): e is string => typeof e === 'string'),
  };
}

/** The path strings a `skills` / `commands` value names (a string, an array, or a map of them). */
function pathRefsOf(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (typeof v === 'string') {
      out.push(v);
    } else if (depth < 3 && Array.isArray(v)) {
      for (const x of v) {
        visit(x, depth + 1);
      }
    } else if (depth < 3 && v && typeof v === 'object') {
      const source = (v as { source?: unknown }).source;
      if (typeof source === 'string') {
        out.push(source);
      } else {
        for (const x of Object.values(v)) {
          visit(x, depth + 1);
        }
      }
    }
  };
  visit(value, 0);
  return out;
}

const isMarkdown = (p: string) => /\.md$/i.test(p);
const isSkillFile = (p: string) => /(^|\/)skill\.md$/i.test(p);

interface MdCandidates {
  /** Skill and command markdown files the harness loads, by path. */
  paths: Set<string>;
  /** `skills` / `commands` references that cannot be followed: [ref, why]. */
  unresolved: { key: string; ref: string; why: string }[];
}

/**
 * The `.md` files the harness's plugin loader reads as a skill or a command: `skills/**\/SKILL.md`,
 * `commands/**\/*.md`, and whatever `plugin.json` names under `skills` and `commands`. Over-inclusive
 * on purpose: a file listed here that has no frontmatter hook costs nothing.
 */
function markdownCandidates(
  dir: string,
  files: readonly ProfileFile[],
  manifestDoc: unknown
): MdCandidates {
  const paths = new Set<string>();
  const unresolved: MdCandidates['unresolved'] = [];
  for (const f of files) {
    if (f.path.startsWith(`${dir}/skills/`) && isSkillFile(f.path)) {
      paths.add(f.path);
    } else if (f.path.startsWith(`${dir}/commands/`) && isMarkdown(f.path)) {
      paths.add(f.path);
    }
  }
  for (const key of ['skills', 'commands'] as const) {
    for (const ref of pathRefsOf(valueAt(manifestDoc, [key]))) {
      const target = resolveInside(dir, ref);
      if (target === null) {
        unresolved.push({ key, ref, why: 'a path points outside the plugin folder' });
        continue;
      }
      for (const f of files) {
        if (f.path === target && isMarkdown(f.path)) {
          paths.add(f.path);
        } else if (f.path.startsWith(`${target}/`) && isMarkdown(f.path)) {
          if (key === 'commands' || isSkillFile(f.path)) {
            paths.add(f.path);
          }
        }
      }
    }
  }
  return { paths, unresolved };
}

// --- frontmatter -----------------------------------------------------------------------------

type Frontmatter =
  | { kind: 'none' }
  | { kind: 'unreadable'; why: string; digest: string }
  | {
      kind: 'ok';
      text: string;
      /** Offsets of the frontmatter text (between the fences) inside `text`. */
      start: number;
      end: number;
      pairs: Pair[];
      doc: NonNullable<ReturnType<typeof parseDocument>>;
    };

/**
 * Parse frontmatter YAML, duplicate keys allowed. A document with an alias is refused (null):
 * expansion is how a small text becomes a huge one, and no plugin needs it.
 */
function parseDocument(front: string): ReturnType<typeof parseYaml> | null {
  const doc = parseYaml(front, { uniqueKeys: false });
  let aliased = false;
  visit(doc, {
    Alias() {
      aliased = true;
      return visit.BREAK;
    },
  });
  return aliased || isAlias(doc.contents) ? null : doc;
}

const OPENER = /^---[ \t]*(?:\r\n|\n|\r)/;

/**
 * Locate and parse a markdown file's YAML frontmatter. Tolerates a BOM and CRLF. A file that
 * opens with a fence but whose frontmatter cannot be told apart from what the loader will read is
 * `unreadable`, never "no frontmatter": the loader's own pattern ends at the first `---` anywhere,
 * so a difference between that reading and ours that mentions hooks is refused.
 */
function readFrontmatter(bytes: Buffer): Frontmatter {
  const text = utf8(bytes, true);
  if (text === null) {
    return { digest: sha256(bytes), kind: 'unreadable', why: 'not valid UTF-8' };
  }
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const opener = OPENER.exec(text.slice(bom));
  if (!opener) {
    return { kind: 'none' };
  }
  const start = bom + opener[0].length;
  const loader = /^---\s*\n([\s\S]*?)---/.exec(text.slice(bom))?.[1];
  const closing = /^---[ \t]*(?:\r\n|\n|\r|$)/gm;
  closing.lastIndex = start;
  let match = closing.exec(text);
  while (match && match.index < start) {
    match = closing.exec(text);
  }
  const digestOf = (s: string) => sha256(s);
  if (!match) {
    if (loader !== undefined && /hooks/i.test(loader)) {
      return {
        digest: digestOf(loader),
        kind: 'unreadable',
        why: 'its frontmatter has no closing fence line but names hooks',
      };
    }
    return { kind: 'none' };
  }
  const end = match.index;
  const front = text.slice(start, end);
  const norm = (s: string) => s.replace(/\r\n?/g, '\n');
  if (loader !== undefined && norm(loader) !== norm(front) && /hooks/i.test(loader)) {
    return {
      digest: digestOf(front),
      kind: 'unreadable',
      why: 'its frontmatter is read differently by the loader',
    };
  }
  const doc = parseDocument(front);
  if (!doc || doc.errors.length > 0) {
    return {
      digest: digestOf(front),
      kind: 'unreadable',
      why: 'its frontmatter is not valid YAML',
    };
  }
  const pairs: Pair[] = [];
  if (isMap(doc.contents)) {
    for (const p of doc.contents.items) {
      if (isScalar(p.key) && p.key.value === 'hooks') {
        pairs.push(p);
      }
    }
  }
  return { doc, end, kind: 'ok', pairs, start, text };
}

const jsOf = (node: unknown): unknown =>
  node && typeof (node as { toJSON?: unknown }).toJSON === 'function'
    ? (node as { toJSON: () => unknown }).toJSON()
    : null;

/** The text of `fm` without any `hooks` key. Throws when the result cannot be shown to be right. */
function withoutHooksKey(path: string, fm: Extract<Frontmatter, { kind: 'ok' }>): string {
  const fail = (why: string) => new AutoRunSourceError(`${display(path)}: ${why}`);
  const original = fm.text.slice(fm.start, fm.end);
  let front: string;
  const contents = fm.doc.contents;
  if (isMap(contents) && contents.flow === true) {
    // A flow map (`{ hooks: ..., name: x }`) has commas to keep straight: write it again.
    const copy = parseDocument(original);
    if (copy && isMap(copy.contents)) {
      copy.contents.items = copy.contents.items.filter(
        (p) => !(isScalar(p.key) && p.key.value === 'hooks')
      );
    }
    if (!copy) {
      throw fail('its frontmatter is not valid YAML');
    }
    front = copy.toString({ flowCollectionPadding: true });
  } else {
    front = original;
    const ranges = fm.pairs
      .map((p) => {
        const keyRange = (p.key as { range?: [number, number, number] }).range;
        const valueRange = (p.value as { range?: [number, number, number] } | null)?.range;
        if (!keyRange) {
          throw fail('a frontmatter hooks key has no source position');
        }
        const keyStart = keyRange[0];
        const valueEnd = Math.max(valueRange?.[1] ?? 0, keyRange[1]);
        const from = original.lastIndexOf('\n', keyStart - 1) + 1;
        let to = valueEnd;
        if (original[to - 1] !== '\n') {
          const nl = original.indexOf('\n', to);
          to = nl === -1 ? original.length : nl + 1;
        }
        return { from, to };
      })
      .sort((a, b) => b.from - a.from);
    for (const r of ranges) {
      front = front.slice(0, r.from) + front.slice(r.to);
    }
  }
  const out = fm.text.slice(0, fm.start) + front + fm.text.slice(fm.end);

  // Verify: the other keys are unchanged, no hooks key is left, and the body is byte-identical.
  const before = parseDocument(original)?.toJS() as unknown;
  const reread = readFrontmatter(Buffer.from(out, 'utf8'));
  if (reread.kind !== 'ok' || reread.pairs.length > 0) {
    throw fail('the hooks key could not be removed from its frontmatter');
  }
  const after = reread.doc.toJS() as unknown;
  const expected =
    before && typeof before === 'object' && !Array.isArray(before)
      ? Object.fromEntries(Object.entries(before).filter(([k]) => k !== 'hooks'))
      : before;
  const got = after ?? {};
  if (JSON.stringify(expected ?? {}) !== JSON.stringify(got)) {
    throw fail('removing the hooks key would have changed other frontmatter keys');
  }
  if (out.slice(out.length - (fm.text.length - fm.end)) !== fm.text.slice(fm.end)) {
    throw fail('the body would have changed');
  }
  return out;
}

// --- sources ---------------------------------------------------------------------------------

/**
 * Every auto-run command source of every plugin in a snapshot. A source that cannot be read still
 * appears (with `unreadable`), so it counts as present, shows in a diff and is reported by the
 * scanner. A plugin directory that is not a safe relative path has none: the validator refuses it.
 */
export function autoRunSourcesOf(
  files: readonly ProfileFile[],
  manifest: { plugins?: readonly string[] } | null | undefined
): AutoRunSource[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const out = new Map<string, AutoRunSource>();
  const add = (s: AutoRunSource) => {
    if (!out.has(s.path)) {
      out.set(s.path, s);
    }
  };
  const fileSource = (plugin: string, kind: AutoRunKind, file: ProfileFile): AutoRunSource => {
    const parsed = parseJson(file.bytes);
    return {
      commands: parsed.ok ? commandsIn(parsed.value, withArgsFor(kind)) : [],
      digest: sha256(file.bytes),
      kind,
      path: file.path,
      plugin,
      ...(parsed.ok ? {} : { unreadable: 'the file is not valid UTF-8 JSON' }),
    };
  };

  for (const raw of manifest?.plugins ?? []) {
    const dir = pluginDirOf(raw);
    if (dir === null) {
      continue;
    }
    for (const { rel, kind } of DEFAULT_FILES) {
      const file = byPath.get(`${dir}/${rel}`);
      if (file) {
        add(fileSource(dir, kind, file));
      }
    }
    const pluginJsonPath = `${dir}/${PLUGIN_MANIFEST}`;
    const pluginJson = byPath.get(pluginJsonPath);
    let manifestDoc: unknown;
    if (pluginJson) {
      const parsed = parseJson(pluginJson.bytes);
      manifestDoc = parsed.ok ? parsed.value : undefined;
    }
    if (manifestDoc !== undefined) {
      for (const key of MANIFEST_KEYS) {
        const value = valueAt(manifestDoc, key.path);
        if (value === undefined) {
          continue;
        }
        const { inline, refs } = entriesOf(value);
        if (inline.length > 0) {
          const path = `${pluginJsonPath}#${key.label}`;
          add({
            commands: commandsIn(inline, withArgsFor(key.kind)),
            digest: sha256(JSON.stringify(inline)),
            kind: key.kind,
            path,
            plugin: dir,
          });
        }
        for (const ref of refs) {
          const target = resolveInside(dir, ref);
          const file = target === null ? undefined : byPath.get(target);
          if (target !== null && file) {
            // Re-keyed by the named file's own path; the first kind to claim a path keeps it.
            add(fileSource(dir, key.kind, file));
          } else {
            const path = `${pluginJsonPath}#${key.label}:${ref}`;
            add({
              commands: [],
              digest: sha256(`unresolved:${ref}`),
              kind: key.kind,
              path,
              plugin: dir,
              unreadable:
                target === null
                  ? 'a path points outside the plugin folder'
                  : 'the named file is missing',
            });
          }
        }
      }
    }
    const md = markdownCandidates(dir, files, manifestDoc);
    for (const u of md.unresolved) {
      add({
        commands: [],
        digest: sha256(`unresolved:${u.key}:${u.ref}`),
        kind: 'frontmatter-hooks',
        path: `${pluginJsonPath}#${u.key}:${u.ref}`,
        plugin: dir,
        unreadable: u.why,
      });
    }
    for (const path of [...md.paths].sort()) {
      const file = byPath.get(path);
      if (!file) {
        continue;
      }
      const fm = readFrontmatter(file.bytes);
      if (fm.kind === 'unreadable') {
        add({
          commands: [],
          digest: fm.digest,
          kind: 'frontmatter-hooks',
          path: `${path}#hooks`,
          plugin: dir,
          unreadable: fm.why,
        });
      } else if (fm.kind === 'ok' && fm.pairs.length > 0) {
        const values = fm.pairs.map((p) => jsOf(p.value));
        add({
          commands: commandsIn(values, false),
          digest: sha256(JSON.stringify(values)),
          kind: 'frontmatter-hooks',
          path: `${path}#hooks`,
          plugin: dir,
        });
      }
    }
  }
  return [...out.values()];
}

// --- strip -----------------------------------------------------------------------------------

/**
 * The files to write into the container with hooks OFF: the snapshot minus every auto-run source.
 *
 *  - `hooks/hooks.json`, `monitors/monitors.json`, `.lsp.json` and every file `plugin.json` names
 *    under `hooks`, `monitors`, `experimental.monitors` or `lspServers` are left out;
 *  - `plugin.json` is written again without those keys (and nothing else changed);
 *  - every skill and command `.md` is written again without its `hooks` frontmatter key, the body
 *    byte for byte.
 *
 * Scripts and executables are still written. The input is never altered. Throws
 * `AutoRunSourceError` for a plugin directory that is not a safe path, a missing or unparseable
 * `plugin.json`, a named path that leaves the plugin folder or names a missing or non-JSON file,
 * and frontmatter that cannot be parsed or cleanly edited.
 */
export function stripAutoRunSources(
  files: readonly ProfileFile[],
  manifest: { plugins?: readonly string[] } | null | undefined
): ProfileFile[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const dropped = new Set<string>();
  const rewritten = new Map<string, Buffer>();
  const fail = (why: string) => new AutoRunSourceError(why);

  for (const raw of manifest?.plugins ?? []) {
    const dir = pluginDirOf(raw);
    if (dir === null) {
      throw fail('a plugin path is not a safe relative path');
    }
    for (const { rel } of DEFAULT_FILES) {
      dropped.add(`${dir}/${rel}`);
    }
    const pluginJsonPath = `${dir}/${PLUGIN_MANIFEST}`;
    const pluginJson = byPath.get(pluginJsonPath);
    if (!pluginJson) {
      throw fail(`its ${PLUGIN_MANIFEST} is missing from the snapshot`);
    }
    const parsed = parseJson(pluginJson.bytes);
    if (!parsed.ok) {
      throw fail(`its ${PLUGIN_MANIFEST} is not valid JSON`);
    }
    const doc = parsed.value;
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw fail(`its ${PLUGIN_MANIFEST} is not a JSON object`);
    }
    const root = doc as Record<string, unknown>;
    let touched = false;
    for (const key of MANIFEST_KEYS) {
      const value = valueAt(root, key.path);
      if (value === undefined) {
        continue;
      }
      for (const ref of entriesOf(value).refs) {
        const target = resolveInside(dir, ref);
        if (target === null) {
          throw fail(`a ${key.label} path points outside the plugin folder`);
        }
        const file = byPath.get(target);
        if (!file) {
          throw fail(`a ${key.label} path names a file that is not in the snapshot`);
        }
        if (!parseJson(file.bytes).ok) {
          throw fail(`a ${key.label} file is not valid UTF-8 JSON`);
        }
        dropped.add(target);
      }
      const parent =
        key.path.length === 1 ? root : (valueAt(root, key.path.slice(0, -1)) as object);
      delete (parent as Record<string, unknown>)[key.path.at(-1) as string];
      touched = true;
    }
    if (touched) {
      const exp = root.experimental;
      if (exp && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).length === 0) {
        delete root.experimental;
      }
      rewritten.set(pluginJsonPath, Buffer.from(`${JSON.stringify(root, null, 2)}\n`, 'utf8'));
    }

    const md = markdownCandidates(dir, files, parsed.value);
    if (md.unresolved.length > 0) {
      const u = md.unresolved[0];
      throw fail(`a ${u?.key} ${u?.why}`);
    }
    for (const path of md.paths) {
      const file = byPath.get(path);
      if (!file || dropped.has(path)) {
        continue;
      }
      const fm = readFrontmatter(file.bytes);
      if (fm.kind === 'unreadable') {
        throw fail(`${display(path)}: ${fm.why}`);
      }
      if (fm.kind === 'ok' && fm.pairs.length > 0) {
        rewritten.set(path, Buffer.from(withoutHooksKey(path, fm), 'utf8'));
      }
    }
  }
  return files
    .filter((f) => !dropped.has(f.path))
    .map((f) => {
      const bytes = rewritten.get(f.path);
      return bytes ? { ...f, bytes } : f;
    });
}
