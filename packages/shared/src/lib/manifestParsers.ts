/**
 * Pure, I/O-free manifest parsers for the repo dependency graph's manifest
 * detector (P1, see docs/history/repo-dependency-graph-rfc.md). Given the raw
 * text content of a known manifest file, extract the raw dependency name
 * strings it declares. Resolution of a raw string against candidate repos
 * happens separately in `repoDependencyMatch.ts` — these parsers never see a
 * repo list.
 *
 * Defensive by design: a manifest is written by hand in a target repo this
 * platform does not control, so malformed input is expected, not exceptional.
 * Every parser here returns `[]` on anything it can't make sense of instead of
 * throwing — a parse failure must never sink the whole detector run.
 */

/** Manifest file paths the detector tries, in order, for every scanned repo. */
export const MANIFEST_FILES = [
  'package.json',
  'go.mod',
  'requirements.txt',
  'pom.xml',
  'Cargo.toml',
] as const;

export type ManifestFile = (typeof MANIFEST_FILES)[number];

/**
 * Parse a manifest's content into raw (unresolved) dependency name strings.
 * `path` may be a bare filename or a full repo-relative path (e.g.
 * `.github/CODEOWNERS`-style callers use their own parser; this only looks at
 * the basename) — dispatch is by basename so a nested manifest (e.g. a
 * monorepo's `services/api/package.json`) still parses.
 */
export function parseManifest(path: string, content: string): string[] {
  const base = path.split('/').pop() ?? path;
  try {
    switch (base) {
      case 'package.json':
        return parsePackageJson(content);
      case 'go.mod':
        return parseGoMod(content);
      case 'requirements.txt':
        return parseRequirementsTxt(content);
      case 'pom.xml':
        return parsePomXml(content);
      case 'Cargo.toml':
        return parseCargoToml(content);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

function parsePackageJson(content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const section = (parsed as Record<string, unknown>)[field];
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      for (const name of Object.keys(section)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * `go.mod` requires appear either as a single-line `require module version`
 * or inside a `require ( … )` block, one module per line. Both forms may
 * carry a trailing `// indirect` comment.
 */
function parseGoMod(content: string): string[] {
  const names = new Set<string>();
  let inBlock = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('//')[0].trim();
    if (!line) {
      continue;
    }
    if (inBlock) {
      if (line === ')') {
        inBlock = false;
        continue;
      }
      const mod = line.split(/\s+/)[0];
      if (mod) {
        names.add(mod);
      }
      continue;
    }
    const blockStart = line.match(/^require\s*\($/);
    if (blockStart) {
      inBlock = true;
      continue;
    }
    const single = line.match(/^require\s+(\S+)\s+\S+/);
    if (single) {
      names.add(single[1]);
    }
  }
  return [...names];
}

/**
 * `requirements.txt`: one requirement (or option) per line. Strips comments,
 * blank lines, `-e`/`-r`/other `-`-prefixed option lines, and version
 * specifiers/extras/environment markers, leaving the bare package name.
 */
function parseRequirementsTxt(content: string): string[] {
  const names = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line || line.startsWith('-')) {
      continue;
    }
    // Strip environment markers (`; python_version < "3.8"`), extras
    // (`[foo,bar]`), and version specifiers (==, >=, <=, ~=, !=, <, >, ===).
    const name = line
      .split(';')[0]
      .split(/[[<>=!~]/)[0]
      .trim();
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * `pom.xml`: extracts `groupId:artifactId` from every top-level `<dependency>`
 * block. Deliberately not a real XML parser — a tolerant regex scan is enough
 * for the well-formed manifests this reads, and a malformed document just
 * yields fewer (or no) matches rather than throwing.
 */
function parsePomXml(content: string): string[] {
  const names = new Set<string>();
  const depBlocks = content.match(/<dependency>[\s\S]*?<\/dependency>/g) ?? [];
  for (const block of depBlocks) {
    const groupId = block.match(/<groupId>\s*([^<\s]+)\s*<\/groupId>/)?.[1];
    const artifactId = block.match(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/)?.[1];
    if (groupId && artifactId) {
      names.add(`${groupId}:${artifactId}`);
    }
  }
  return [...names];
}

/**
 * `Cargo.toml`: collects dependency crate names from `[dependencies]` /
 * `[dev-dependencies]` / `[build-dependencies]` key = value lines, and from
 * `[dependencies.name]` / `[dev-dependencies.name]` sub-table headers. A
 * lightweight line scanner, not a full TOML parser — sufficient for the
 * common manifest shapes without pulling in a TOML dependency.
 */
function parseCargoToml(content: string): string[] {
  const names = new Set<string>();
  const depSectionRe = /^(dependencies|dev-dependencies|build-dependencies)$/;
  let inDepSection = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) {
      continue;
    }
    const sectionHeader = line.match(/^\[([^\]]+)\]$/);
    if (sectionHeader) {
      const section = sectionHeader[1].trim();
      if (depSectionRe.test(section)) {
        inDepSection = true;
        continue;
      }
      // `[dependencies.name]` sub-table — capture the crate name directly.
      const subTable = section.match(/^(dependencies|dev-dependencies|build-dependencies)\.(.+)$/);
      if (subTable) {
        names.add(subTable[2].trim());
        inDepSection = false;
        continue;
      }
      inDepSection = false;
      continue;
    }
    if (inDepSection) {
      const kv = line.match(/^([^\s=]+)\s*=/);
      if (kv) {
        names.add(kv[1].trim().replace(/^"(.*)"$/, '$1'));
      }
    }
  }
  return [...names];
}

/**
 * `.gitmodules`: extracts submodule URLs. INI-style — a `url = …` line under
 * each `[submodule "name"]` section.
 */
export function parseGitmodules(content: string): string[] {
  const urls = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    const url = line.match(/^url\s*=\s*(\S+)\s*$/);
    if (url) {
      urls.add(url[1]);
    }
  }
  return [...urls];
}

/**
 * `CODEOWNERS`: extracts owner tokens (`@user`, `@org/team`, or an email
 * address) from every non-comment line, ignoring the leading path pattern.
 */
export function parseCodeowners(content: string): string[] {
  const owners = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.split('#')[0].trim();
    if (!line) {
      continue;
    }
    const tokens = line.split(/\s+/).slice(1); // drop the path pattern
    for (const token of tokens) {
      if (token.startsWith('@') || token.includes('@')) {
        owners.add(token);
      }
    }
  }
  return [...owners];
}
