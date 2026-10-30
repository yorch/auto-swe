/**
 * The PyPI allowlist: the name==version pairs a repository's committed lockfile pins.
 *
 * Names are PEP 503-normalised and versions are canonicalised (a conservative PEP 440
 * subset), so `Foo_Bar 1.0.0` in a lockfile and `foo-bar-1.0.whl` on the index compare equal.
 * A version the canonicaliser cannot read is `null` and the caller treats that as "not
 * allowed": the allowlist fails closed.
 *
 * Pure and I/O-free: every lockfile is attacker-influenced (a repository's own file), so nothing
 * here throws on it, no regex has a nested quantifier, and every parser bounds its input.
 * There is no TOML library; the lockfile tables are read by hand and only for the few keys needed.
 */

export const PYPI_LOCKFILE_NAMES = [
  'uv.lock',
  'poetry.lock',
  'pylock.toml',
  'Pipfile.lock',
  'requirements.txt',
] as const;

/** A hostile file is refused above this many characters. */
const MAX_TEXT_CHARS = 8 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
/** A longer line is skipped, not truncated: half a line could read as a different pin. */
const MAX_LINE_CHARS = 2_000;
const MAX_NAME_CHARS = 200;
const MAX_VERSION_CHARS = 128;
const MAX_FILENAME_CHARS = 300;

export interface PypiRequirement {
  /** PEP 503-normalised. */
  name: string;
  /** Canonical. */
  version: string;
}

/** Normalised name → canonical versions. */
export type PypiAllowlist = Map<string, Set<string>>;

/** PEP 503: lowercase, each run of `-`, `_`, `.` becomes one `-`. */
export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export function isValidPypiName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_CHARS) {
    return false;
  }
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(normalizePypiName(name));
}

// Groups: 1 epoch, 2 release, 3 pre label, 4 pre number, 5 implicit post (`-1`), 6 post label,
// 7 post number, 8 dev label, 9 dev number, 10 local.
const VERSION_RE =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/;

const PRE_LABELS: Record<string, string> = {
  a: 'a',
  alpha: 'a',
  b: 'b',
  beta: 'b',
  c: 'rc',
  pre: 'rc',
  preview: 'rc',
  rc: 'rc',
};

/** `007` and `7` are the same number in PEP 440; the canonical form has no leading zeros. */
function stripLeadingZeros(digits: string): string {
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * A conservative PEP 440 canonicaliser: the canonical string, or `null` when `v` does not read
 * as a version. Callers must treat `null` as "never allowed".
 */
export function normalizePypiVersion(v: string): string | null {
  if (v.length === 0 || v.length > MAX_VERSION_CHARS) {
    return null;
  }
  const m = VERSION_RE.exec(v.toLowerCase());
  if (!m) {
    return null;
  }
  const [
    ,
    epoch,
    rawRelease,
    preLabel,
    preNum,
    implicitPost,
    postLabel,
    postNum,
    devLabel,
    devNum,
    local,
  ] = m;
  const segments = (rawRelease as string).split('.').map(stripLeadingZeros);
  while (segments.length > 1 && segments[segments.length - 1] === '0') {
    segments.pop();
  }
  let out = '';
  if (epoch !== undefined && stripLeadingZeros(epoch) !== '0') {
    out += `${stripLeadingZeros(epoch)}!`;
  }
  out += segments.join('.');
  if (preLabel !== undefined) {
    out += `${PRE_LABELS[preLabel]}${stripLeadingZeros(preNum ?? '0')}`;
  }
  if (implicitPost !== undefined) {
    out += `.post${stripLeadingZeros(implicitPost)}`;
  } else if (postLabel !== undefined) {
    out += `.post${stripLeadingZeros(postNum ?? '0')}`;
  }
  if (devLabel !== undefined) {
    out += `.dev${stripLeadingZeros(devNum ?? '0')}`;
  }
  if (local !== undefined) {
    out += `+${local
      .replace(/[-_]/g, '.')
      .split('.')
      .map((seg) => (/^\d+$/.test(seg) ? stripLeadingZeros(seg) : seg))
      .join('.')}`;
  }
  return out;
}

const SDIST_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz', '.zip', '.tgz'];

/**
 * The project and version a distribution filename names (wheel or sdist), normalised; `null`
 * for any other kind of file.
 */
export function parsePypiFilename(file: string): { name: string; version: string } | null {
  if (file.length === 0 || file.length > MAX_FILENAME_CHARS) {
    return null;
  }
  if (file.endsWith('.whl')) {
    const parts = file.slice(0, -'.whl'.length).split('-');
    if (parts.length !== 5 && parts.length !== 6) {
      return null;
    }
    if (parts.length === 6 && !/^[0-9]/.test(parts[2] as string)) {
      return null;
    }
    if (parts.some((p) => p.length === 0)) {
      return null;
    }
    const version = normalizePypiVersion(parts[1] as string);
    const name = parts[0] as string;
    return version !== null && isValidPypiName(name)
      ? { name: normalizePypiName(name), version }
      : null;
  }
  const ext = SDIST_EXTENSIONS.find((e) => file.endsWith(e));
  if (ext === undefined) {
    return null;
  }
  const stem = file.slice(0, -ext.length);
  for (let dash = stem.lastIndexOf('-'); dash > 0; dash = stem.lastIndexOf('-', dash - 1)) {
    const rest = stem.slice(dash + 1);
    if (!/^[0-9]/.test(rest)) {
      continue;
    }
    const version = normalizePypiVersion(rest);
    const name = stem.slice(0, dash);
    if (version !== null && isValidPypiName(name)) {
      return { name: normalizePypiName(name), version };
    }
  }
  return null;
}

/** Validates and normalises one pin; `null` when either half is unusable. */
function toRequirement(name: string, version: string): PypiRequirement | null {
  if (!isValidPypiName(name)) {
    return null;
  }
  const canonical = normalizePypiVersion(version);
  return canonical === null ? null : { name: normalizePypiName(name), version: canonical };
}

function lines(text: string): string[] {
  return text.split('\n');
}

// --- TOML ---------------------------------------------------------------------------------

/** A string literal at the start of `s` (basic or literal), and whether only a comment follows. */
function readTomlString(s: string): string | null {
  const quote = s[0];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  const end = s.indexOf(quote, 1);
  if (end < 0) {
    return null;
  }
  const value = s.slice(1, end);
  // An escape would need real TOML decoding; refuse rather than guess.
  if (quote === '"' && value.includes('\\')) {
    return null;
  }
  const tail = s.slice(end + 1).trim();
  return tail === '' || tail.startsWith('#') ? value : null;
}

/** The right-hand side of `key = …` on `line`, or `null` when the line is not that key. */
function valueOfKey(line: string, key: string): string | null {
  if (!line.startsWith(key)) {
    return null;
  }
  const rest = line.slice(key.length).trimStart();
  return rest.startsWith('=') ? rest.slice(1).trim() : null;
}

interface TomlTable {
  /** Top-level string keys, read only before the first sub-table header. */
  keys: Map<string, string>;
  /** The raw right-hand side of a top-level `source = …` line. */
  inlineSource: string | null;
  /** Header text (`package.source`) → its string keys. */
  subs: Map<string, Map<string, string>>;
}

/** The sub-table header text of a `[a.b]` / `[[a.b]]` line. */
function headerOf(line: string): string {
  const hash = line.indexOf('#');
  const bare = hash >= 0 ? line.slice(0, hash) : line;
  return bare.trim().replace(/^\[+/, '').replace(/\]+$/, '').trim();
}

/**
 * The `[[<array>]]` tables of a TOML file. Inside one, only top-level `name`/`version` (and the
 * `source` line) are read; once a `[…]` line opens a sub-table, string keys go to that sub-table
 * so a wheel's or dependency's `version` can never be mistaken for the package's.
 */
function readTomlTables(text: string, array: string): TomlTable[] {
  if (text.length > MAX_TEXT_CHARS) {
    return [];
  }
  const tables: TomlTable[] = [];
  let current: TomlTable | null = null;
  let sub: Map<string, string> | null = null;
  for (const raw of lines(text)) {
    if (raw.length > MAX_LINE_CHARS) {
      continue;
    }
    const line = raw.trim();
    if (line.startsWith('[')) {
      if (headerOf(line) === array && line.startsWith('[[')) {
        if (tables.length >= MAX_ENTRIES) {
          break;
        }
        current = { inlineSource: null, keys: new Map(), subs: new Map() };
        tables.push(current);
        sub = null;
      } else if (current !== null && headerOf(line).startsWith(`${array}.`)) {
        sub = current.subs.get(headerOf(line)) ?? new Map<string, string>();
        current.subs.set(headerOf(line), sub);
      } else {
        // Another top-level table ends the package.
        current = null;
        sub = null;
      }
      continue;
    }
    if (current === null) {
      continue;
    }
    const target = sub ?? current.keys;
    for (const key of ['name', 'version', 'type']) {
      const rhs = valueOfKey(line, key);
      const value = rhs === null ? null : readTomlString(rhs);
      if (value !== null) {
        target.set(key, value);
      }
    }
    if (sub === null && current.inlineSource === null) {
      current.inlineSource = valueOfKey(line, 'source');
    }
  }
  return tables;
}

/** An inline `source = { … }` that names a key other than an index. */
const NON_INDEX_SOURCE_KEY_RE = /[{,\s](?:editable|virtual|path|directory|git|url)\s*=/;

function hasNonIndexInlineSource(source: string | null): boolean {
  if (source === null) {
    return false;
  }
  const withoutStrings = source.replace(/"[^"]*"|'[^']*'/g, '""');
  return NON_INDEX_SOURCE_KEY_RE.test(withoutStrings);
}

function requirementsFromTables(
  tables: TomlTable[],
  skip: (table: TomlTable) => boolean
): PypiRequirement[] {
  const out: PypiRequirement[] = [];
  for (const table of tables) {
    const name = table.keys.get('name');
    const version = table.keys.get('version');
    if (name === undefined || version === undefined || skip(table)) {
      continue;
    }
    const req = toRequirement(name, version);
    if (req !== null) {
      out.push(req);
    }
  }
  return out;
}

/** `uv.lock`: `[[package]]` tables; editable, virtual, path, directory, git and url sources are not the index. */
export function parseUvLock(text: string): PypiRequirement[] {
  return requirementsFromTables(readTomlTables(text, 'package'), (t) =>
    hasNonIndexInlineSource(t.inlineSource)
  );
}

/** `poetry.lock`: `[[package]]` tables; a `[package.source]` of type git, directory, file or url is not the index. */
export function parsePoetryLock(text: string): PypiRequirement[] {
  return requirementsFromTables(readTomlTables(text, 'package'), (t) =>
    ['git', 'directory', 'file', 'url'].includes(t.subs.get('package.source')?.get('type') ?? '')
  );
}

/** `pylock.toml` (PEP 751): `[[packages]]` tables; a vcs, directory or archive package is not the index. */
export function parsePylockToml(text: string): PypiRequirement[] {
  return requirementsFromTables(readTomlTables(text, 'packages'), (t) =>
    ['packages.vcs', 'packages.directory', 'packages.archive'].some((h) => t.subs.has(h))
  );
}

// --- requirements.txt ---------------------------------------------------------------------

/** Physical lines joined across trailing `\`; an over-long physical line is dropped. */
function logicalRequirementLines(text: string): string[] {
  const out: string[] = [];
  let pending = '';
  for (const rawLine of lines(text)) {
    const raw = rawLine.replace(/\r$/, '');
    if (raw.length > MAX_LINE_CHARS) {
      // Whatever was being joined ends here; the dropped line contributes nothing.
      if (pending !== '') {
        out.push(pending);
        pending = '';
      }
      continue;
    }
    if (raw.endsWith('\\')) {
      pending += `${raw.slice(0, -1)} `;
      continue;
    }
    out.push(pending + raw);
    pending = '';
  }
  if (pending !== '') {
    out.push(pending);
  }
  return out;
}

function isNameChar(c: string): boolean {
  return /[A-Za-z0-9._-]/.test(c);
}

/** One logical requirements line → a pin, or `null` when it is not `name==version`. */
function pinFromRequirementLine(logical: string): PypiRequirement | null {
  let line = logical;
  // A comment starts at `#` at the line start or after whitespace (pip's rule).
  const comment = line.search(/(^|\s)#/);
  if (comment >= 0) {
    line = line.slice(0, comment);
  }
  line = line.trim();
  if (line === '' || line.startsWith('-')) {
    return null;
  }
  const marker = line.indexOf(';');
  if (marker >= 0) {
    line = line.slice(0, marker);
  }
  // Per-requirement options (`--hash=…`) follow the specifier after whitespace.
  const option = line.search(/\s-/);
  if (option >= 0) {
    line = line.slice(0, option);
  }
  line = line.trim();
  if (line.includes('@') || line.includes('://')) {
    return null;
  }
  let i = 0;
  while (i < line.length && isNameChar(line[i] as string)) {
    i += 1;
  }
  const name = line.slice(0, i);
  let rest = line.slice(i).trimStart();
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) {
      return null;
    }
    rest = rest.slice(close + 1).trimStart();
  }
  let version: string;
  if (rest.startsWith('===')) {
    version = rest.slice(3);
  } else if (rest.startsWith('==')) {
    version = rest.slice(2);
  } else {
    return null;
  }
  return toRequirement(name, version.trim());
}

/** `requirements.txt`: `name==version` / `name===version` pins only. `-r` is never followed. */
export function parseRequirementsTxt(text: string): PypiRequirement[] {
  if (text.length > MAX_TEXT_CHARS) {
    return [];
  }
  const out: PypiRequirement[] = [];
  for (const logical of logicalRequirementLines(text)) {
    if (out.length >= MAX_ENTRIES) {
      break;
    }
    const req = pinFromRequirementLine(logical);
    if (req !== null) {
      out.push(req);
    }
  }
  return out;
}

// --- Pipfile.lock -------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const PIPFILE_NON_INDEX_KEYS = ['git', 'path', 'file', 'editable'];

/** `Pipfile.lock`: `==x` pins in `default` and `develop`; VCS, path and file entries are skipped. */
export function parsePipfileLock(text: string): PypiRequirement[] {
  if (text.length > MAX_TEXT_CHARS) {
    return [];
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(doc)) {
    return [];
  }
  const out: PypiRequirement[] = [];
  for (const section of ['default', 'develop']) {
    const entries = doc[section];
    if (!isRecord(entries)) {
      continue;
    }
    for (const [name, entry] of Object.entries(entries)) {
      if (out.length >= MAX_ENTRIES) {
        return out;
      }
      if (!isRecord(entry) || typeof entry.version !== 'string') {
        continue;
      }
      if (PIPFILE_NON_INDEX_KEYS.some((k) => Object.hasOwn(entry, k))) {
        continue;
      }
      if (!entry.version.startsWith('==') || entry.version.startsWith('===')) {
        continue;
      }
      const req = toRequirement(name, entry.version.slice(2).trim());
      if (req !== null) {
        out.push(req);
      }
    }
  }
  return out;
}

// --- dispatch -----------------------------------------------------------------------------

const REQUIREMENTS_NAME_RE = /^requirements[-_.A-Za-z0-9]*\.txt$/;
const PYLOCK_NAME_RE = /^pylock\.[-_.A-Za-z0-9]+\.toml$/;

/** Whether a basename is one `parsePypiLockfile` reads. */
export function isPypiLockfileName(base: string): boolean {
  return (
    (PYPI_LOCKFILE_NAMES as readonly string[]).includes(base) ||
    PYLOCK_NAME_RE.test(base) ||
    REQUIREMENTS_NAME_RE.test(base)
  );
}

/** The pins of a lockfile, chosen by its basename; an unrecognised name yields nothing. */
export function parsePypiLockfile(fileName: string, text: string): PypiRequirement[] {
  const base = fileName.slice(Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\')) + 1);
  if (base === 'uv.lock') {
    return parseUvLock(text);
  }
  if (base === 'poetry.lock') {
    return parsePoetryLock(text);
  }
  if (base === 'pylock.toml' || PYLOCK_NAME_RE.test(base)) {
    return parsePylockToml(text);
  }
  if (base === 'Pipfile.lock') {
    return parsePipfileLock(text);
  }
  if (REQUIREMENTS_NAME_RE.test(base)) {
    return parseRequirementsTxt(text);
  }
  return [];
}

export function buildPypiAllowlist(reqs: PypiRequirement[]): PypiAllowlist {
  const out: PypiAllowlist = new Map();
  for (const r of reqs) {
    const req = toRequirement(r.name, r.version);
    if (req === null) {
      continue;
    }
    const set = out.get(req.name) ?? new Set<string>();
    set.add(req.version);
    out.set(req.name, set);
  }
  return out;
}

export function isPypiAllowed(list: PypiAllowlist, name: string, version: string): boolean {
  if (!isValidPypiName(name)) {
    return false;
  }
  const canonical = normalizePypiVersion(version);
  return canonical !== null && (list.get(normalizePypiName(name))?.has(canonical) ?? false);
}
