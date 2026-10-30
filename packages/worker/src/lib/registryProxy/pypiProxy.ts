/**
 * The PyPI simple-index protocol, as far as a read-only proxy needs it. Pure: no I/O, no state.
 *
 * Two request shapes exist, both GET: the project index `/simple/<project>/` and a file download.
 * The index is read (PEP 691 JSON or PEP 503 HTML), filtered, and re-rendered as PEP 503 HTML whose
 * every file link points back at this proxy: the file URL an upstream names is never handed to the
 * client, it is kept server-side under an opaque id (`fileIdFor`) and fetched only from there. That
 * is what keeps the registry credential and the allowlist in force for a file hosted elsewhere
 * (PyPI serves files from `files.pythonhosted.org`, not from the index host).
 *
 * The index is attacker-influenced text (a mirror, a compromised upstream), so every parser here is
 * linear-time, bounded, and drops what it cannot read instead of guessing.
 */
import { createHash } from 'node:crypto';
import {
  isPypiAllowed,
  isValidPypiName,
  normalizePypiName,
  type PypiAllowlist,
  parsePypiFilename,
} from '@auto-swe/shared/lib/pypiAllowlist';

export type PypiPath =
  /** `project` is PEP 503-normalised. */
  { kind: 'index'; project: string } | { kind: 'file'; fileId: string; filename: string };

export interface PypiIndexFile {
  filename: string;
  /** Absolute http(s) URL, no userinfo, no fragment. */
  url: string;
  /** `algo=hex`, sha256 preferred. */
  hash?: string;
  requiresPython?: string;
  /** `true`, or the reason. Absent when the file is not yanked. */
  yanked?: string | true;
}

export interface PypiRenderedFile {
  filename: string;
  href: string;
  hash?: string;
  requiresPython?: string;
  yanked?: string | true;
}

const MAX_INDEX_FILES = 100_000;
const MAX_ATTR_CHARS = 4_000;
/** A text node longer than this cannot be a distribution filename. */
const MAX_ANCHOR_TEXT_CHARS = 2_000;

const FILE_ID_RE = /^[0-9a-f]{32}$/;
const PROJECT_CHARS_RE = /^[A-Za-z0-9._-]{1,200}$/;
/** What a file route's filename segment may hold; also what an index entry's filename must match. */
const FILENAME_RE = /^[A-Za-z0-9._+!~-]{1,300}$/;
/** `algo=hex`: a hash named by an index. */
const HASH_RE = /^[a-z0-9_]{1,16}=[0-9a-f]{8,512}$/;

/** `rest` is the path after `/pypi/<token>/<registryId>`: a leading `/`, no query. */
export function parsePypiPath(rest: string): PypiPath | null {
  if (!rest.startsWith('/')) {
    return null;
  }
  // `%`, a backslash, `?`, `#` and whitespace match no segment charset below.
  const segments = rest.split('/');
  const [, route, first, second] = segments;
  if (route === 'simple' && (segments.length === 3 || (segments.length === 4 && second === ''))) {
    if (first === undefined || !PROJECT_CHARS_RE.test(first) || !isValidPypiName(first)) {
      return null;
    }
    return { kind: 'index', project: normalizePypiName(first) };
  }
  if (route === 'files' && segments.length === 4) {
    if (
      first === undefined ||
      second === undefined ||
      !FILE_ID_RE.test(first) ||
      !FILENAME_RE.test(second) ||
      second.includes('..')
    ) {
      return null;
    }
    return { fileId: first, filename: second, kind: 'file' };
  }
  return null;
}

/** The opaque id a file is served under: stable for a registry and URL, unguessable without both. */
export function fileIdFor(registryId: string, url: string): string {
  return createHash('sha256').update(`${registryId}\0${url}`).digest('hex').slice(0, 32);
}

// --- reading an index ----------------------------------------------------------------------

const ENTITY_RE = /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
};

/** One pass, so `&amp;lt;` is `&lt;` and never `<`. An unknown or out-of-range entity stays as written. */
function decodeEntities(s: string): string {
  if (!s.includes('&')) {
    return s;
  }
  return s.replace(ENTITY_RE, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower[0] !== '#') {
      return NAMED_ENTITIES[lower] ?? whole;
    }
    const code = lower[1] === 'x' ? Number.parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return Number.isInteger(code) &&
      code > 0 &&
      code <= 0x10ffff &&
      !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code)
      : whole;
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The best `algo=hex` of a PEP 691 `hashes` object: sha256 if well formed, else the first that is. */
function pickHash(hashes: unknown): string | undefined {
  if (!isRecord(hashes)) {
    return undefined;
  }
  let fallback: string | undefined;
  for (const [algo, value] of Object.entries(hashes)) {
    if (typeof value !== 'string') {
      continue;
    }
    const candidate = `${algo.toLowerCase()}=${value.toLowerCase()}`;
    if (!HASH_RE.test(candidate)) {
      continue;
    }
    if (algo.toLowerCase() === 'sha256') {
      return candidate;
    }
    fallback ??= candidate;
  }
  return fallback;
}

interface RawEntry {
  filename: string;
  url: string;
  /** A hash already known from the fragment of an HTML href. */
  hash?: string;
  requiresPython?: string;
  yanked?: string | true;
}

/** The entry if its filename and URL are both usable, else `null`. */
function toIndexFile(raw: RawEntry, baseUrl: string): PypiIndexFile | null {
  if (
    !FILENAME_RE.test(raw.filename) ||
    raw.filename.includes('..') ||
    parsePypiFilename(raw.filename) === null ||
    raw.url.length === 0 ||
    raw.url.length > MAX_ATTR_CHARS
  ) {
    return null;
  }
  let resolved: URL;
  try {
    resolved = new URL(raw.url, baseUrl);
  } catch {
    return null;
  }
  if (
    (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
    resolved.username !== '' ||
    resolved.password !== ''
  ) {
    return null;
  }
  resolved.hash = '';
  return {
    filename: raw.filename,
    url: resolved.href,
    ...(raw.hash !== undefined ? { hash: raw.hash } : {}),
    ...(raw.requiresPython !== undefined ? { requiresPython: raw.requiresPython } : {}),
    ...(raw.yanked !== undefined ? { yanked: raw.yanked } : {}),
  };
}

function parseJsonIndex(body: string, baseUrl: string): PypiIndexFile[] | null {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(doc) || !Array.isArray(doc.files)) {
    return null;
  }
  const out: PypiIndexFile[] = [];
  for (const f of doc.files as unknown[]) {
    if (out.length >= MAX_INDEX_FILES) {
      break;
    }
    if (!isRecord(f) || typeof f.filename !== 'string' || typeof f.url !== 'string') {
      continue;
    }
    const rp = f['requires-python'];
    const y = f.yanked;
    if (
      (typeof rp === 'string' && rp.length > MAX_ATTR_CHARS) ||
      (typeof y === 'string' && y.length > MAX_ATTR_CHARS)
    ) {
      continue;
    }
    const file = toIndexFile(
      {
        filename: f.filename,
        hash: pickHash(f.hashes),
        requiresPython: typeof rp === 'string' ? rp : undefined,
        url: f.url,
        // Anything that is not plainly "not yanked" reads as yanked: that only ever makes pip
        // less willing to pick the file.
        yanked:
          y === undefined || y === null || y === false
            ? undefined
            : typeof y === 'string'
              ? y
              : true,
      },
      baseUrl
    );
    if (file) {
      out.push(file);
    }
  }
  return out;
}

const isSpace = (c: string | undefined): boolean =>
  c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

const WANTED_ATTRS: ReadonlySet<string> = new Set(['href', 'data-requires-python', 'data-yanked']);

interface ParsedTag {
  /** Decoded values of the attributes read; the first occurrence of a name wins. */
  attrs: Map<string, string>;
  /** An attribute we read was longer than MAX_ATTR_CHARS: the anchor is dropped. */
  oversized: boolean;
  /** Index just past the closing `>`. */
  end: number;
}

/**
 * The attributes of the tag whose name ended at `from`, or `null` when it never closes. Each
 * character is visited once and every step either consumes input or returns, so the scan is linear
 * whatever the tag holds (an unterminated quote ends the whole parse rather than being retried).
 */
function readTag(s: string, from: number): ParsedTag | null {
  const n = s.length;
  const attrs = new Map<string, string>();
  let oversized = false;
  let i = from;
  for (;;) {
    while (i < n && (isSpace(s[i]) || s[i] === '/')) {
      i += 1;
    }
    if (i >= n) {
      return null;
    }
    if (s[i] === '>') {
      return { attrs, end: i + 1, oversized };
    }
    const nameStart = i;
    while (i < n && !isSpace(s[i]) && s[i] !== '=' && s[i] !== '>' && s[i] !== '/') {
      i += 1;
    }
    const name = i - nameStart <= 32 ? s.slice(nameStart, i).toLowerCase() : '';
    while (i < n && isSpace(s[i])) {
      i += 1;
    }
    let valueStart = i;
    let valueEnd = i;
    if (s[i] === '=') {
      i += 1;
      while (i < n && isSpace(s[i])) {
        i += 1;
      }
      const quote = s[i];
      if (quote === '"' || quote === "'") {
        const close = s.indexOf(quote, i + 1);
        if (close < 0) {
          return null;
        }
        valueStart = i + 1;
        valueEnd = close;
        i = close + 1;
      } else {
        valueStart = i;
        while (i < n && !isSpace(s[i]) && s[i] !== '>') {
          i += 1;
        }
        valueEnd = i;
      }
    }
    if (WANTED_ATTRS.has(name) && !attrs.has(name)) {
      if (valueEnd - valueStart > MAX_ATTR_CHARS) {
        oversized = true;
      } else {
        attrs.set(name, decodeEntities(s.slice(valueStart, valueEnd)));
      }
    }
  }
}

/** PEP 503: `<a href="url#hash" data-requires-python="…" data-yanked="…">filename</a>`. */
function parseHtmlIndex(body: string, baseUrl: string): PypiIndexFile[] | null {
  const out: PypiIndexFile[] = [];
  const n = body.length;
  let sawAnchor = false;
  let i = 0;
  while (i < n && out.length < MAX_INDEX_FILES) {
    const lt = body.indexOf('<', i);
    if (lt < 0) {
      break;
    }
    if (body.startsWith('<!--', lt)) {
      const end = body.indexOf('-->', lt + 4);
      if (end < 0) {
        break;
      }
      i = end + 3;
      continue;
    }
    const tagName = body[lt + 1];
    if ((tagName !== 'a' && tagName !== 'A') || !isSpace(body[lt + 2])) {
      i = lt + 1;
      continue;
    }
    const tag = readTag(body, lt + 2);
    if (tag === null) {
      break;
    }
    sawAnchor = true;
    const nextLt = body.indexOf('<', tag.end);
    const textEnd = nextLt < 0 ? n : nextLt;
    i = textEnd;
    const href = tag.attrs.get('href');
    if (tag.oversized || href === undefined || textEnd - tag.end > MAX_ANCHOR_TEXT_CHARS) {
      continue;
    }
    const hashAt = href.indexOf('#');
    const fragment = hashAt < 0 ? '' : href.slice(hashAt + 1).toLowerCase();
    const file = toIndexFile(
      {
        filename: decodeEntities(body.slice(tag.end, textEnd)).trim(),
        hash: HASH_RE.test(fragment) ? fragment : undefined,
        requiresPython: tag.attrs.get('data-requires-python'),
        url: hashAt < 0 ? href : href.slice(0, hashAt),
        yanked: tag.attrs.get('data-yanked'),
      },
      baseUrl
    );
    if (file) {
      out.push(file);
    }
  }
  return sawAnchor ? out : null;
}

/**
 * The files a simple index lists, or `null` when `body` is neither a PEP 691 JSON nor a PEP 503
 * HTML index. The content type picks the reader; a missing or unfamiliar one is sniffed by the
 * first character. Entries with an unusable URL (not http(s), userinfo) or a filename that is not
 * a wheel or sdist of a valid project are dropped, so what comes back is safe to register. The
 * caller bounds `body`.
 */
export function parseSimpleIndex(
  body: string,
  contentType: string,
  baseUrl: string
): PypiIndexFile[] | null {
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const first = body.trimStart()[0];
  if (type === 'application/vnd.pypi.simple.v1+json' || type === 'application/json') {
    return parseJsonIndex(body, baseUrl);
  }
  if (type === 'text/html' || type === 'application/vnd.pypi.simple.v1+html') {
    return parseHtmlIndex(body, baseUrl);
  }
  if (first === '{') {
    return parseJsonIndex(body, baseUrl);
  }
  return first === '<' ? parseHtmlIndex(body, baseUrl) : null;
}

// --- writing an index ----------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  "'": '&#39;',
  '"': '&quot;',
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/**
 * A PEP 503 index for `project`, one anchor per file. It deliberately omits
 * `data-core-metadata` / `data-dist-info-metadata` (PEP 658): the `.metadata` files are not
 * proxied, so a client that was told one exists would ask for it and get a 404. Without the
 * attribute it downloads the wheel and reads the metadata from that.
 */
export function renderSimpleIndex(project: string, files: PypiRenderedFile[]): string {
  const title = `Links for ${escapeHtml(project)}`;
  const anchors = files.map((f) => {
    const href = f.hash === undefined ? f.href : `${f.href}#${f.hash}`;
    const attrs = [`href="${escapeHtml(href)}"`];
    if (f.requiresPython !== undefined) {
      attrs.push(`data-requires-python="${escapeHtml(f.requiresPython)}"`);
    }
    if (f.yanked !== undefined) {
      attrs.push(`data-yanked="${escapeHtml(f.yanked === true ? '' : f.yanked)}"`);
    }
    return `<a ${attrs.join(' ')}>${escapeHtml(f.filename)}</a><br>`;
  });
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta name="pypi:repository-version" content="1.0">',
    `<title>${title}</title>`,
    '</head>',
    '<body>',
    `<h1>${title}</h1>`,
    ...anchors,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// --- lockfile mode -------------------------------------------------------------------------

/**
 * The files of `project` whose name==version the allowlist pins. A file that names another
 * project, or whose version the allowlist does not hold, is dropped and counted.
 */
export function filterAllowedFiles<T extends { filename: string }>(
  files: T[],
  allowlist: PypiAllowlist,
  project: string
): { kept: T[]; dropped: number } {
  const wanted = normalizePypiName(project);
  const kept: T[] = [];
  for (const f of files) {
    const parsed = parsePypiFilename(f.filename);
    if (
      parsed !== null &&
      parsed.name === wanted &&
      isPypiAllowed(allowlist, parsed.name, parsed.version)
    ) {
      kept.push(f);
    }
  }
  return { dropped: files.length - kept.length, kept };
}
