import { createHash } from 'node:crypto';
import {
  defaultDeps,
  fetchBlobBytes,
  listTree,
  normaliseLocation,
  resolveAccess,
  resolveSha,
  SHA_RE,
  type SkillSourceDeps,
  SkillSourceError,
  type SourceLocation,
} from '../skillSource/index.js';
import {
  ENTRY_REASONS,
  MARKETPLACE_FILE,
  MAX_MARKETPLACE_BYTES,
  parseMarketplace,
} from './parse.js';
import type { MarketplaceEntry, ParsedMarketplace } from './types.js';

/** The marketplace file is missing or breaks the format. `errors` are fixed sentences. */
export class MarketplaceInvalid extends Error {
  constructor(readonly errors: string[]) {
    super('the folder does not hold a valid marketplace.json');
    this.name = 'MarketplaceInvalid';
  }
}

export interface MarketplaceRead {
  location: SourceLocation;
  /** The exact commit the catalog was read at. */
  sha: string;
  marketplace: ParsedMarketplace;
}

/**
 * Read `<path>/.claude-plugin/marketplace.json` at an exact commit.
 *
 * Goes through the skill-source machinery end to end (host policy, SSRF guard and connection
 * pinning, manual redirects, platform credential only, rate floor, fixed error strings, no bare
 * `fetch`). Costs three requests: the ref, the tree and the one file. Only that file is
 * downloaded; its size and git object id are checked against the listing. `atSha` reads that
 * commit without consulting the ref; `expectSha` fails `SHA_MOVED` when the ref no longer
 * resolves to the commit a preview showed.
 */
export async function readMarketplace(
  input: SourceLocation,
  opts: { atSha?: string; expectSha?: string } = {},
  deps: SkillSourceDeps = defaultDeps
): Promise<MarketplaceRead> {
  const location = normaliseLocation(input);
  const access = await resolveAccess(location.host, deps);
  if (opts.atSha !== undefined && !SHA_RE.test(opts.atSha)) {
    throw new SkillSourceError('INVALID_SOURCE');
  }
  const sha = opts.atSha ?? (await resolveSha(access, location));
  if (opts.expectSha !== undefined && opts.expectSha !== sha) {
    throw new SkillSourceError('SHA_MOVED');
  }
  const wanted = location.path === '' ? MARKETPLACE_FILE : `${location.path}/${MARKETPLACE_FILE}`;
  const entry = (await listTree(access, location, sha)).find((e) => e.path === wanted);
  if (entry?.type !== 'blob') {
    throw new MarketplaceInvalid([`${MARKETPLACE_FILE} not found at that path and commit`]);
  }
  if (entry.mode !== '100644' && entry.mode !== '100755') {
    throw new MarketplaceInvalid([`${MARKETPLACE_FILE} must be a regular file`]);
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new SkillSourceError('BAD_RESPONSE');
  }
  if (entry.size > MAX_MARKETPLACE_BYTES) {
    throw new MarketplaceInvalid([`${MARKETPLACE_FILE} exceeds ${MAX_MARKETPLACE_BYTES} bytes`]);
  }
  const bytes = await fetchBlobBytes(access, location, entry.sha);
  const id = createHash(entry.sha.length === 64 ? 'sha256' : 'sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
  if (bytes.length !== entry.size || id !== entry.sha) {
    throw new SkillSourceError('BAD_RESPONSE');
  }
  const parsed = parseMarketplace(bytes);
  if (!parsed.ok) {
    throw new MarketplaceInvalid(parsed.errors);
  }
  return { location, marketplace: parsed.marketplace, sha };
}

/** Where to read an installable entry's plugin folder. */
export interface EntryFolder {
  location: SourceLocation;
  /**
   * The commit the entry is fixed to: the marketplace commit for a relative entry, the entry's own
   * `sha` for a GitHub entry that names one. Null for a GitHub entry that only names a ref: the
   * caller resolves it and binds an approval to it with `expectSha`.
   */
  fixedSha: string | null;
}

/**
 * The folder of an installable entry. A relative entry is read from the marketplace repository at
 * the marketplace's commit; a GitHub entry from its own repository (`github.com`, default ref
 * `HEAD`). Throws for an entry that is not installable.
 */
export function entryFolder(
  marketplace: SourceLocation,
  entry: MarketplaceEntry,
  marketplaceSha: string
): EntryFolder {
  const source = entry.source;
  if (!entry.installable || !source || source.kind === 'unsupported') {
    throw new MarketplaceInvalid([entry.reason ?? ENTRY_REASONS.UNSUPPORTED_SOURCE]);
  }
  if (source.kind === 'relative') {
    // The marketplace folder is the plugin root: relative sources resolve against it.
    const path = [marketplace.path, source.path].filter((s) => s !== '').join('/');
    return {
      fixedSha: marketplaceSha,
      location: { ...marketplace, path },
    };
  }
  return {
    fixedSha: source.sha,
    location: {
      host: source.host,
      owner: source.owner,
      path: source.path,
      ref: source.ref,
      repo: source.repo,
    },
  };
}
