/**
 * Glob matching for repo-relative paths, case-insensitive and anchored. It does
 * not compile to a regular expression: the matcher walks the path once per
 * token, so cost is tokens x path length no matter how a pattern is written.
 * Supports `**`, `**` followed by a slash, `*`, `?` and `{a,b}` (no nesting).
 */

export const DEFAULT_SENSITIVE_PATHS: readonly string[] = [
  // migrations
  '**/migrations/**',
  '**/*.sql',
  '**/schema.prisma',
  '**/db/migrate/**',
  '**/db/migration/**',
  '**/db/migrations/**',
  '**/db/schema.rb',
  '**/alembic/**',
  // auth
  '**/auth/**',
  '**/authz/**',
  '**/authn/**',
  '**/*permission*',
  '**/*rbac*',
  '**/*acl*',
  '**/oauth/**',
  // ci / workflow
  '.github/**',
  '.gitlab-ci.yml',
  'Jenkinsfile',
  '.circleci/**',
  'azure-pipelines.yml',
  // infra
  '**/Dockerfile*',
  '**/*.Dockerfile',
  '**/Containerfile*',
  '**/*.tf',
  '**/*.tfvars',
  '**/helm/**',
  '**/charts/**',
  '**/k8s/**',
  '**/docker-compose*.yml',
  '**/docker-compose*.yaml',
  '**/compose.y*ml',
  // dependencies and build
  '**/package.json',
  '**/yarn.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/go.mod',
  '**/go.sum',
  '**/Cargo.toml',
  '**/Cargo.lock',
  '**/requirements*.txt',
  '**/pyproject.toml',
  '**/setup.py',
  '**/setup.cfg',
  '**/Pipfile*',
  '**/uv.lock',
  '**/poetry.lock',
  '**/pom.xml',
  '**/build.gradle*',
  '**/*.gradle',
  '**/*.gradle.kts',
  '**/Gemfile*',
  '**/Makefile',
  '**/justfile',
  '**/.npmrc',
  '**/.yarnrc*',
  '**/.pypirc',
  // secrets-adjacent
  '**/.env*',
  '**/*secret*',
  '**/*credential*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/*.p12',
  '**/*.pfx',
  '**/*.jks',
  '**/*.keystore',
  // contracts
  '**/*.proto',
  '**/openapi*.{yml,yaml,json}',
  '**/swagger*',
  // policy and guard
  '.auto-swe/**',
  '**/CODEOWNERS',
  '**/biome.json*',
  '**/.eslintrc*',
  '**/eslint.config.*',
  '**/.husky/**',
  '**/lefthook.y*ml',
  '**/.pre-commit-config.y*ml',
  '**/.git*',
  // agent instructions
  '**/AGENTS.md',
  '**/CLAUDE.md',
  '**/.claude/**',
  '**/.cursor/**',
  '**/.cursorrules',
  '**/copilot-instructions.md',
  // test-gating config
  '**/vitest.config.*',
  '**/jest.config.*',
  '**/playwright.config.*',
  '**/karma.conf.*',
  '**/.mocharc*',
  '**/pytest.ini',
  '**/tox.ini',
  '**/.coveragerc',
];

export const TEST_FILE_GLOBS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/*_spec.*',
  '**/test_*.py',
  '**/conftest.py',
  '**/*Test.java',
  '**/*Tests.java',
  '**/*Test.kt',
  '**/*Test.cs',
  '**/*Tests.cs',
  '**/test/**',
  '**/tests/**',
  '**/spec/**',
  '**/testing/**',
  '**/__tests__/**',
  '**/e2e/**',
  '**/cypress/**',
  '**/playwright/**',
];

/** Files that are not behaviour: changing only these does not call for a test. */
export const NON_SOURCE_GLOBS: readonly string[] = [
  '**/*.{md,mdx,txt,rst,png,jpg,jpeg,gif,svg}',
  'docs/**',
  '**/LICENSE*',
];

/** Added lines in a test file that switch tests off. Linear: one pass, no nested quantifiers. */
export const TEST_SKIP_PATTERN =
  /\.(skip|only|todo)\b|\bx(it|test|describe)\s*\(|skipIf|skipUnless|@pytest\.mark\.(skip|xfail)|\bt\.Skip(Now)?\b|@Disabled|@Ignore|@Pending|\bpending\s*\(|skipTest|\bunittest\.skip/;

/**
 * The paths a bot approval may cover: documentation and tests. Every changed path must match one,
 * on top of the sensitive-path rules, which still make a change HIGH before this list is asked.
 */
export const DEFAULT_BOT_APPROVAL_PATHS: readonly string[] = [
  '**/*.md',
  '**/*.mdx',
  'docs/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/test/**',
  '**/tests/**',
];

/** Most globs the bot approval allowlist may hold. */
export const MAX_BOT_APPROVAL_PATHS = 50;

export const MAX_GLOB_LENGTH = 200;
export const MAX_PATH_LENGTH = 1024;
/** Most alternatives one glob may expand to. */
export const MAX_GLOB_EXPANSIONS = 16;
/** Most `*` tokens one repository-supplied glob may hold. */
export const MAX_GLOB_STARS = 8;

type Token =
  | { kind: 'lit'; ch: string }
  | { kind: 'any1' }
  | { kind: 'star' }
  | { kind: 'deep' }
  | { kind: 'deepSlash' };

/** Expands `{a,b}` groups; null when braces are nested or unclosed or the result is too big. */
function expandBraces(glob: string): string[] | null {
  let results = [''];
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] as string;
    if (ch === '\\' && i + 1 < glob.length) {
      results = results.map((r) => r + glob.slice(i, i + 2));
      i += 2;
    } else if (ch === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        return null;
      }
      const body = glob.slice(i + 1, close);
      if (body.includes('{')) {
        return null;
      }
      const alternatives = body.split(',');
      if (results.length * alternatives.length > MAX_GLOB_EXPANSIONS) {
        return null;
      }
      results = results.flatMap((r) => alternatives.map((a) => r + a));
      i = close + 1;
    } else if (ch === '}') {
      return null;
    } else {
      results = results.map((r) => r + ch);
      i++;
    }
  }
  return results;
}

function tokenize(glob: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i] as string;
    if (ch === '*') {
      let end = i;
      while (glob[end] === '*') {
        end++;
      }
      const atSegmentStart = i === 0 || glob[i - 1] === '/';
      if (end - i >= 2 && atSegmentStart && glob[end] === '/') {
        tokens.push({ kind: 'deepSlash' });
        i = end + 1;
      } else {
        tokens.push(end - i >= 2 ? { kind: 'deep' } : { kind: 'star' });
        i = end;
      }
    } else if (ch === '?') {
      tokens.push({ kind: 'any1' });
      i++;
    } else if (ch === '\\' && i + 1 < glob.length) {
      tokens.push({ ch: glob[i + 1] as string, kind: 'lit' });
      i += 2;
    } else {
      tokens.push({ ch, kind: 'lit' });
      i++;
    }
  }
  return tokens;
}

type Compiled = { tokens: Token[]; minLength: number };

const MAX_COMPILED_CACHE = 2048;
const compiled = new Map<string, Compiled[] | null>();

function compile(glob: string): Compiled[] | null {
  const cached = compiled.get(glob);
  if (cached !== undefined) {
    return cached;
  }
  let result: Compiled[] | null = null;
  if (glob.length > 0 && glob.length <= MAX_GLOB_LENGTH && !glob.includes('\0')) {
    const expanded = expandBraces(glob.toLowerCase());
    result = expanded
      ? expanded.map((alternative) => {
          const tokens = tokenize(alternative);
          return {
            minLength: tokens.filter((t) => t.kind === 'lit' || t.kind === 'any1').length,
            tokens,
          };
        })
      : null;
  }
  if (compiled.size >= MAX_COMPILED_CACHE) {
    compiled.clear();
  }
  compiled.set(glob, result);
  return result;
}

/** Whether a glob is well formed and within bounds; a bad one never matches anything. */
export function isValidGlob(glob: string): boolean {
  return compile(glob) !== null;
}

/** Number of `*` runs in a glob. */
export function countGlobStars(glob: string): number {
  return (glob.match(/\*+/g) ?? []).length;
}

/** Tokens summed over every brace alternative: the per-path work a glob costs. */
export function globCost(glob: string): number {
  return (compile(glob) ?? []).reduce((sum, alt) => sum + alt.tokens.length, 0);
}

// Shared scratch rows: matching is synchronous, so one pair is safe and allocation-free.
const reachRow = new Uint8Array(MAX_PATH_LENGTH + 1);
const SLASH = 0x2f;

function matchTokens(tokens: Token[], codes: Uint16Array, n: number): boolean {
  reachRow.fill(0, 0, n + 1);
  reachRow[0] = 1;
  for (const token of tokens) {
    let any = 0;
    if (token.kind === 'lit') {
      const want = token.ch.charCodeAt(0);
      for (let j = n - 1; j >= 0; j--) {
        const v = reachRow[j] === 1 && codes[j] === want ? 1 : 0;
        reachRow[j + 1] = v;
        any |= v;
      }
      reachRow[0] = 0;
    } else if (token.kind === 'any1') {
      for (let j = n - 1; j >= 0; j--) {
        const v = reachRow[j] === 1 && codes[j] !== SLASH ? 1 : 0;
        reachRow[j + 1] = v;
        any |= v;
      }
      reachRow[0] = 0;
    } else if (token.kind === 'star' || token.kind === 'deep') {
      const crossSlash = token.kind === 'deep';
      any = reachRow[0] as number;
      for (let j = 1; j <= n; j++) {
        if (reachRow[j] !== 1 && reachRow[j - 1] === 1 && (crossSlash || codes[j - 1] !== SLASH)) {
          reachRow[j] = 1;
        }
        any |= reachRow[j] as number;
      }
    } else {
      // zero or more whole directories: the empty match, or anything ending in a slash
      let seen = false;
      for (let j = 0; j <= n; j++) {
        const old = reachRow[j] === 1;
        if (!old && j > 0 && seen && codes[j - 1] === SLASH) {
          reachRow[j] = 1;
        }
        if (old) {
          seen = true;
        }
        any |= reachRow[j] as number;
      }
    }
    if (any === 0) {
      return false;
    }
  }
  return reachRow[n] === 1;
}

type PreparedPath = { codes: Uint16Array; n: number };

function preparePath(path: string): PreparedPath | null {
  if (path.length > MAX_PATH_LENGTH) {
    return null;
  }
  const text = path.toLowerCase();
  // Lower-casing can change length (rare); anything out of bounds never matches.
  if (text.length > MAX_PATH_LENGTH) {
    return null;
  }
  const codes = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) {
    codes[i] = text.charCodeAt(i);
  }
  return { codes, n: text.length };
}

function matchPrepared(glob: string, prepared: PreparedPath): boolean {
  const alternatives = compile(glob);
  if (!alternatives) {
    return false;
  }
  return alternatives.some(
    (alt) => alt.minLength <= prepared.n && matchTokens(alt.tokens, prepared.codes, prepared.n)
  );
}

export function globMatches(glob: string, path: string): boolean {
  const prepared = preparePath(path);
  return prepared !== null && matchPrepared(glob, prepared);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  const prepared = preparePath(path);
  return prepared !== null && globs.some((glob) => matchPrepared(glob, prepared));
}

export function isTestFile(path: string): boolean {
  return matchesAny(path, TEST_FILE_GLOBS);
}
