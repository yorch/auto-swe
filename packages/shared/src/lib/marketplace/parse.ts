import { z } from 'zod';
import { ProfileNameSchema } from '../harnessProfile/manifest.js';
import { HIDDEN_CHARACTERS } from '../skillSource/display.js';
import { normaliseLocation, SHA_RE } from '../skillSource/index.js';
import type { EntrySource, MarketplaceEntry, ParsedMarketplace } from './types.js';

/** Where a marketplace keeps its catalog, relative to the marketplace folder. */
export const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';
export const MAX_MARKETPLACE_BYTES = 1_000_000;
export const MAX_MARKETPLACE_ENTRIES = 500;
const MAX_IGNORED_KEYS = 20;
const MAX_DESCRIPTION = 1000;

/** Why an entry cannot be installed. Fixed sentences: an entry is repository text. */
export const ENTRY_REASONS = {
  DUPLICATE_NAME: 'another entry has the same name',
  INVALID_ENTRY: 'the entry has no valid name or source',
  INVALID_PATH: 'the source path is not a safe relative path',
  INVALID_REPO: 'the source repository, ref or commit is not valid',
  UNSUPPORTED_SOURCE:
    'only a path inside the marketplace repository or a GitHub repository can be installed',
} as const;

const KNOWN_TOP = new Set(['name', 'owner', 'plugins', 'metadata']);
const KNOWN_ENTRY = new Set(['name', 'description', 'version', 'source']);

const shown = (s: string, max: number) => {
  const clean = s.replace(HIDDEN_CHARACTERS, '?');
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
};

function ignored(obj: Record<string, unknown>, known: Set<string>): string[] {
  return Object.keys(obj)
    .filter((k) => !known.has(k))
    .sort()
    .slice(0, MAX_IGNORED_KEYS)
    .map((k) => shown(k, 60));
}

/**
 * A repo-relative folder: no `..`, `.` or empty segment, not absolute, no backslash, no control or
 * invisible character. A leading `./` is dropped and `.` is the folder itself (''). Null when it is
 * anything else.
 */
export function safeRelativeFolder(raw: string): string | null {
  const p = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (p === '' || p === '.') {
    return raw === '' ? null : '';
  }
  if (p.startsWith('/') || p.includes('\\') || p.replace(HIDDEN_CHARACTERS, '?') !== p) {
    return null;
  }
  if (Buffer.byteLength(p, 'utf8') > 1000) {
    return null;
  }
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.toLowerCase() === '.git')) {
    return null;
  }
  return p;
}

const Top = z.looseObject({
  metadata: z.unknown().optional(),
  name: z.string().min(1).max(200),
  owner: z.unknown().optional(),
  plugins: z.array(z.unknown()).max(MAX_MARKETPLACE_ENTRIES),
});

const GithubSource = z.looseObject({
  path: z.string().max(1000).optional(),
  ref: z.string().min(1).max(255).optional(),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  sha: z.string().optional(),
  source: z.literal('github'),
});

type SourceResult = { source: EntrySource } | { reason: string; source: EntrySource | null };

function parseSource(raw: unknown, pluginRoot: string): SourceResult {
  if (typeof raw === 'string') {
    // `git@host:x/y`, `https://...`, `npm:pkg` and the like.
    if (raw.includes(':')) {
      return {
        reason: ENTRY_REASONS.UNSUPPORTED_SOURCE,
        source: { kind: 'unsupported', type: 'url' },
      };
    }
    const folder = safeRelativeFolder(raw);
    if (folder === null) {
      return { reason: ENTRY_REASONS.INVALID_PATH, source: null };
    }
    const joined = [pluginRoot, folder].filter((s) => s !== '').join('/');
    return { source: { kind: 'relative', path: joined } };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const kind = (raw as { source?: unknown }).source;
    if (kind !== 'github') {
      return {
        reason: ENTRY_REASONS.UNSUPPORTED_SOURCE,
        source: {
          kind: 'unsupported',
          type: typeof kind === 'string' ? shown(kind, 40) : 'unknown',
        },
      };
    }
    const parsed = GithubSource.safeParse(raw);
    if (!parsed.success) {
      return { reason: ENTRY_REASONS.INVALID_REPO, source: null };
    }
    const { path, ref, repo, sha } = parsed.data;
    const [owner, name] = repo.split('/') as [string, string];
    const folder = path === undefined ? '' : safeRelativeFolder(path);
    if (folder === null) {
      return { reason: ENTRY_REASONS.INVALID_PATH, source: null };
    }
    if (sha !== undefined && !SHA_RE.test(sha)) {
      return { reason: ENTRY_REASONS.INVALID_REPO, source: null };
    }
    try {
      const loc = normaliseLocation({
        host: 'github.com',
        owner,
        path: folder,
        ref: ref ?? 'HEAD',
        repo: name,
      });
      return {
        source: {
          host: loc.host,
          kind: 'github',
          owner: loc.owner,
          path: loc.path,
          ref: loc.ref,
          repo: loc.repo,
          sha: sha ?? null,
        },
      };
    } catch {
      return { reason: ENTRY_REASONS.INVALID_REPO, source: null };
    }
  }
  return { reason: ENTRY_REASONS.INVALID_ENTRY, source: null };
}

function pluginRootOf(metadata: unknown): string {
  const raw =
    metadata && typeof metadata === 'object'
      ? (metadata as { pluginRoot?: unknown }).pluginRoot
      : undefined;
  if (typeof raw !== 'string') {
    return '';
  }
  return safeRelativeFolder(raw) ?? '';
}

function parseEntry(raw: unknown, pluginRoot: string): MarketplaceEntry {
  const bad = (reason: string): MarketplaceEntry => ({
    description: null,
    ignoredKeys: [],
    installable: false,
    name: null,
    reason,
    source: null,
    version: null,
  });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return bad(ENTRY_REASONS.INVALID_ENTRY);
  }
  const obj = raw as Record<string, unknown>;
  const name = ProfileNameSchema.safeParse(obj.name);
  const description = typeof obj.description === 'string' ? obj.description : null;
  const version = typeof obj.version === 'string' && obj.version.length <= 64 ? obj.version : null;
  const base = {
    description: description === null ? null : shown(description, MAX_DESCRIPTION),
    ignoredKeys: ignored(obj, KNOWN_ENTRY),
    name: name.success ? name.data : null,
    version: version === null ? null : shown(version, 64),
  };
  const source = parseSource(obj.source, pluginRoot);
  if (!name.success) {
    return {
      ...base,
      installable: false,
      reason: ENTRY_REASONS.INVALID_ENTRY,
      source: source.source,
    };
  }
  if ('reason' in source) {
    return { ...base, installable: false, reason: source.reason, source: source.source };
  }
  if (source.source.kind === 'unsupported') {
    return {
      ...base,
      installable: false,
      reason: ENTRY_REASONS.UNSUPPORTED_SOURCE,
      source: source.source,
    };
  }
  return { ...base, installable: true, reason: null, source: source.source };
}

export type ParseMarketplaceResult =
  | { ok: true; marketplace: ParsedMarketplace }
  | { ok: false; errors: string[] };

/**
 * Parse a Claude Code `marketplace.json`. Strict about the types it reads (`name`, `owner`,
 * `plugins[]` with `name`, `description`, `version`, `source`), lenient about every other key (they
 * are listed as ignored, never an error). One bad entry never fails the file: it is listed, not
 * installable, with a fixed reason. Pure: nothing is fetched. Errors are fixed sentences.
 */
export function parseMarketplace(bytes: Buffer): ParseMarketplaceResult {
  if (bytes.length > MAX_MARKETPLACE_BYTES) {
    return { errors: [`marketplace.json exceeds ${MAX_MARKETPLACE_BYTES} bytes`], ok: false };
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { errors: ['marketplace.json is not valid UTF-8 JSON'], ok: false };
  }
  const top = Top.safeParse(json);
  if (!top.success) {
    return {
      errors: ['marketplace.json needs a name and a plugins list (at most 500 entries)'],
      ok: false,
    };
  }
  const { metadata, name, owner, plugins } = top.data;
  const pluginRoot = pluginRootOf(metadata);
  const ownerName =
    owner && typeof owner === 'object' && typeof (owner as { name?: unknown }).name === 'string'
      ? shown((owner as { name: string }).name, 200)
      : null;
  const entries = plugins.map((p) => parseEntry(p, pluginRoot));
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const e of entries) {
    if (e.name !== null) {
      const key = e.name.toLowerCase();
      (seen.has(key) ? duplicates : seen).add(key);
    }
  }
  for (const e of entries) {
    if (e.name !== null && duplicates.has(e.name.toLowerCase())) {
      e.installable = false;
      e.reason = ENTRY_REASONS.DUPLICATE_NAME;
    }
  }
  return {
    marketplace: {
      entries,
      ignoredKeys: ignored(top.data as Record<string, unknown>, KNOWN_TOP),
      name: shown(name, 200),
      ownerName,
    },
    ok: true,
  };
}
