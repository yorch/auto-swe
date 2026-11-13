#!/usr/bin/env node
/**
 * Source invariant check.
 *
 * `check-doc-drift.mjs` is the compiler for prose. This is the compiler for a
 * narrower thing: rules the type checker cannot state and the test suite does
 * not execute. Each invariant below is here because the bug happened — each
 * shipped to main past a green `yarn test`, `yarn typecheck` and `yarn lint`,
 * and was found by hand afterwards.
 *
 * The bar for adding one: it must be a rule whose violation is (a) silent under
 * the existing gates, and (b) decidable by reading the source. A rule that the
 * type system can enforce belongs in the type system; a rule that a unit test
 * can reach belongs in a unit test.
 *
 * Run: `yarn invariants:check`
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const failures = [];
const fail = (file, line, invariant, detail, why) =>
  failures.push({ detail, file, invariant, line, why });

/** Every file under `dir` matching `test`, recursively. */
function walk(dir, test, acc = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'dist') {
        walk(rel, test, acc);
      }
    } else if (test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

const SCM_DIR = 'packages/worker/src/lib/scm';

/** The only two seam files that make no request, named by full path (never by basename). */
const SCM_NON_PROVIDER_FILES = new Set([`${SCM_DIR}/types.ts`, `${SCM_DIR}/index.ts`]);
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** A repo-relative path with forward slashes, whatever the platform. */
const posixPath = (file) => file.split(sep).join('/').split('\\').join('/');

/**
 * Is `file` (a repo-relative path) a provider file of the SCM seam? Every source file under
 * `packages/worker/src/lib/scm/`, at any depth and in any JS/TS extension, except the interface
 * (`scm/types.ts`) and the dispatcher (`scm/index.ts`) NAMED BY FULL PATH, and tests. A provider
 * that grows a directory (`scm/gitlab/index.ts`, `scm/gitlab/types.ts`) is therefore covered; only
 * the seam's own two top-level files, which make no request, are exempt.
 */
export function isScmProviderFile(file) {
  const f = posixPath(file);
  return (
    f.startsWith(`${SCM_DIR}/`) &&
    SOURCE_EXTENSION.test(f) &&
    !TEST_FILE.test(f) &&
    !SCM_NON_PROVIDER_FILES.has(f)
  );
}

/**
 * Every provider file of the SCM seam (see `isScmProviderFile`). Globbed by directory, not named,
 * so a provider file added later (`gitlab.ts`, `bitbucket/client.ts`) is covered by the rules that
 * use it without anyone having to remember to list it.
 */
export function scmProviderFiles() {
  return walk(SCM_DIR, isScmProviderFile);
}

// ---------------------------------------------------------------------------
// INVARIANT 1 — a workspace image is inherited, never written inline.
//
// `createWorkspace` resolves `image ?? infra.image`. A string literal in
// that argument position is therefore not a default, it is a value: it wins the
// `??` and the operator's configured image is never read. Every call site had
// one, so the configured workspace image did nothing on any path, while the
// docs and the function's own JSDoc said otherwise. Nothing failed — a wrong
// image is a working image.
//
// A named constant is allowed: it forces a deliberate declaration with
// somewhere to write down why (see EVAL_WORKSPACE_IMAGE, the one real case).
// ---------------------------------------------------------------------------

/** Top-level argument slices of a call, given the index of its opening paren. */
function callArgs(src, openParen) {
  const args = [];
  let depth = 0;
  let start = openParen + 1;
  let quote = null;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        args.push(src.slice(start, i));
        return args;
      }
    } else if (c === ',' && depth === 1) {
      args.push(src.slice(start, i));
      start = i + 1;
    }
  }
  return args;
}

const IMAGE_ARG_INDEX = 3; // (repoUrl, branch, defaultBranch, image, …)

function checkWorkspaceImageLiterals() {
  const files = walk('packages/worker/src', (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/\bcreateWorkspace\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const args = callArgs(src, open);
      const arg = args[IMAGE_ARG_INDEX];
      if (arg === undefined) {
        continue; // fewer args than the image position — inherits by omission
      }
      // The connection's own `executorImage` is only part of the answer: the deployer's image for
      // its detected stack sits between it and the default, and `executorImageFor` is what reads
      // it. `repo.executorImage ?? undefined` type-checks, runs, and silently gives every Python,
      // JVM and Go repository the Node image again.
      if (/\bexecutorImage\b/.test(arg) && !/\bexecutorImageFor\s*\(/.test(arg)) {
        fail(
          file,
          src.slice(0, open).split('\n').length,
          'workspace-image-inherited',
          `createWorkspace(…) image argument reads executorImage directly: ${arg.trim()}`,
          'The image for a repository is `executorImageFor(repo)` (lib/executorImage.ts): the ' +
            "connection's executorImage, else the deployer's image for its detected stack, else " +
            'the default. Reading `executorImage` alone skips the stack image.'
        );
      }
      // A quoted string anywhere in the argument means a literal was written
      // inline, whether bare or as the right-hand side of `??`.
      const literal = arg.match(/'([^']*)'|"([^"]*)"/);
      if (literal) {
        fail(
          file,
          src.slice(0, open).split('\n').length,
          'workspace-image-inherited',
          `createWorkspace(…) image argument is the literal ${literal[0].trim()}`,
          'A literal wins the `image ?? infra.image` inside createWorkspace, so the ' +
            "operator's configured image is never read. Pass `executorImageFor(repo)` (lib/executorImage.ts), " +
            'or a named constant if the pin is deliberate (see EVAL_WORKSPACE_IMAGE).'
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 2 — a Dockerfile stage that runs `yarn` must first provide one.
//
// node:26 ships no Corepack and no `yarn`; it left the Node distribution in
// Node 25. Bumping the base image therefore deleted the `yarn` command from
// every build stage, and each one died at exit 127 — after a green test suite,
// typecheck, lint and doc check, because none of them run inside an image.
//
// The converse matters too: the runtime stages run only `node`, and a shim
// there is dead weight in the shipped image.
// ---------------------------------------------------------------------------

/** Provisioning a `yarn` command — a shim, or Corepack's shims. */
const PROVIDES_YARN = /usr\/local\/bin\/yarn|corepack enable/;
/** Invoking yarn as a command: `yarn <subcommand>` at the start of a RUN or after `&&`. */
const INVOKES_YARN = /(?:^RUN\s+|&&\s+)yarn\s+[a-z]/;

function checkDockerfileYarnProvisioning() {
  const dockerfiles = readdirSync(join(ROOT, 'packages'))
    .map((pkg) => join('packages', pkg, 'Dockerfile'))
    .filter((f) => {
      try {
        return statSync(join(ROOT, f)).isFile();
      } catch {
        return false;
      }
    });

  for (const file of dockerfiles) {
    const lines = read(file).split('\n');
    // Split into stages on FROM; keep the 1-based line number of each line.
    const stages = [];
    lines.forEach((text, i) => {
      if (/^FROM\s/.test(text)) {
        stages.push({ from: text, lineNo: i + 1, lines: [] });
      }
      if (stages.length > 0) {
        stages[stages.length - 1].lines.push({ lineNo: i + 1, text });
      }
    });

    for (const stage of stages) {
      const providesAt = stage.lines.find((l) => PROVIDES_YARN.test(l.text))?.lineNo;
      const invokesAt = stage.lines.find(
        (l) => INVOKES_YARN.test(l.text) && !PROVIDES_YARN.test(l.text)
      )?.lineNo;

      if (invokesAt !== undefined && providesAt === undefined) {
        fail(
          file,
          invokesAt,
          'dockerfile-yarn-provisioned',
          `stage "${stage.from.trim()}" runs yarn but never provides one`,
          'node:26 ships no Corepack and no yarn, so this RUN exits 127 at build time. ' +
            'Nothing else catches it: no test, typecheck or lint runs inside the image.'
        );
      } else if (invokesAt !== undefined && providesAt > invokesAt) {
        fail(
          file,
          providesAt,
          'dockerfile-yarn-provisioned',
          `stage "${stage.from.trim()}" provides yarn at line ${providesAt}, after using it at ${invokesAt}`,
          'The shim must exist before the first yarn call in its stage.'
        );
      } else if (invokesAt === undefined && providesAt !== undefined) {
        fail(
          file,
          providesAt,
          'dockerfile-yarn-provisioned',
          `stage "${stage.from.trim()}" provides yarn but never runs it`,
          'Runtime stages run only `node`; a yarn shim there is dead weight in the shipped image.'
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 3 — a layout that reads NEXT_PUBLIC_* at request time renders per request.
//
// `app/layout.tsx` copies NEXT_PUBLIC_API_URL into window.__APP_CONFIG__ so one web image can be
// pointed at any gateway. Next prerenders a layout that has no dynamic API, at `next build`,
// where the variable is unset — so the `?? 'http://localhost:8080'` fallback is written into the
// HTML of every page and the env var set on the running container is never read. The page
// renders, the gateway is healthy, and sign-in fails in the browser with "Service unavailable".
// Locally it is invisible, because the fallback is the address the dev gateway listens on.
// ---------------------------------------------------------------------------

/**
 * The layout takes its public URLs from `lib/env.ts` rather than touching `process.env` itself, so
 * importing from that module is the same request-time read one call away — and the rule has to see
 * through it, or moving the read into a helper switches the rule off without anyone noticing.
 *
 * Deliberately coarse. Working out which helper reads which variable is a call-graph question
 * (`apiInternalUrl()` only calls `publicApiUrl()`; a helper can be an arrow function, or aliased on
 * import), and every shortcut there is a way to defeat the rule. So: any import from `@/lib/env`,
 * while that module reads a `NEXT_PUBLIC_*` variable anywhere, counts. The cost of a false positive
 * is one `export const dynamic` line in a layout that is rendered per request anyway.
 */
function layoutImportsPublicEnv(layoutSrc) {
  const importsEnv = /from\s+['"]@\/lib\/env['"]/.test(layoutSrc);
  return importsEnv && /NEXT_PUBLIC_\w+/.test(read('packages/web/src/lib/env.ts'));
}

function checkLayoutRendersPerRequest() {
  const file = 'packages/web/src/app/layout.tsx';
  const src = read(file);
  const direct = src.match(/process\.env(?:\.|\[\s*['"])NEXT_PUBLIC_\w+/);
  const viaEnvModule = layoutImportsPublicEnv(src);
  if (
    (direct || viaEnvModule) &&
    !/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/.test(src)
  ) {
    const reads = direct ? direct[0] : 'NEXT_PUBLIC_* through @/lib/env';
    const at = direct ? direct[0] : src.match(/from\s+['"]@\/lib\/env['"]/)[0];
    fail(
      file,
      src.slice(0, Math.max(0, src.indexOf(at))).split('\n').length,
      'layout-renders-per-request',
      `the root layout reads ${reads} but does not export dynamic = 'force-dynamic'`,
      'Without it Next prerenders the layout at build time, where the variable is unset, and ' +
        'bakes the fallback into every page. The env var on the running container is ignored.'
    );
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 4 — MCP code reaches data only through a REST route.
//
// An MCP tool is an in-process call to the same route a REST client would use, so the route's
// role check, visibility filter, tenant guard, rate limit and audit apply to it unchanged. A tool
// that read the database itself would be a second permission path, written by hand and reviewed
// by nobody: it type-checks, its own tests pass, and it ignores a visibility rule the route has.
//
// So the MCP transport and tools (`lib/mcp/**`, `routes/mcp.ts`) take no database access, by
// import or by reaching for the `prisma` decoration on the Fastify instance. The wiring that does
// need the database (`lib/mcpRouteOptions.ts`, `lib/mcpTokenVerifier.ts`, the grants) lives
// outside those paths and hands the MCP code plain functions.
//
// Unlike the rules above, this is a standing constraint on a new surface, not a past incident.
// ---------------------------------------------------------------------------

const MCP_CODE_DIR = 'packages/gateway/src/lib/mcp';
const MCP_ROUTE_FILE = 'packages/gateway/src/routes/mcp.ts';

/**
 * What MCP code may import: an allowlist, not a blocklist. A blocklist can only name the
 * spellings someone thought of (`@auto-swe/shared/db`, the `@auto-swe/shared` barrel, a dynamic
 * `import()`, a service that itself uses Prisma), and every omitted one is a way around the rule.
 * Everything not listed here is refused, so a new dependency is a deliberate edit to this list.
 */
const ALLOWED_PACKAGES = new Set([
  '@auto-swe/shared/lib/agentRun',
  '@auto-swe/shared/lib/gitRef',
  '@modelcontextprotocol/server',
  'better-auth/node',
  'fastify',
  'fastify-plugin',
  'zod',
]);
/** Pure gateway modules (no I/O) MCP code may import, as repo-relative `.ts` paths; `lib/mcp/` is always allowed. */
const ALLOWED_LOCAL = new Set([
  'packages/gateway/src/lib/mcpOAuth.ts',
  'packages/gateway/src/lib/ticketId.ts',
]);

/** Every module specifier a file pulls in: static, side-effect, re-export, dynamic and require. */
function moduleSpecifiers(code) {
  const found = [];
  for (const m of code.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g)) {
    found.push(m[2]);
  }
  for (const m of code.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) {
    found.push(m[2]);
  }
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*(['"`])([^'"`]*)\1/g)) {
    found.push(m[2]);
  }
  // A call whose argument is not a plain string cannot be checked, so it is refused.
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*(?!['"`])/g)) {
    found.push(`<computed:${m[0]}>`);
  }
  return found;
}

function importAllowed(file, specifier) {
  if (specifier.startsWith('node:') || ALLOWED_PACKAGES.has(specifier)) {
    return true;
  }
  if (!specifier.startsWith('.')) {
    return false;
  }
  const target = relative(ROOT, join(ROOT, dirname(file), specifier)).replace(/\.js$/, '.ts');
  return (
    target.startsWith(`${MCP_CODE_DIR}/`) || ALLOWED_LOCAL.has(target) || target === MCP_ROUTE_FILE
  );
}

/** Ways to name the database that need no import: the decoration, a destructured alias, bracket access. */
const DATABASE_WORDS = [
  [/\bprisma\b/i, 'names `prisma` (app.prisma, a destructured alias, app["prisma"], an import)'],
  [/\bPrismaClient\b/, 'names PrismaClient'],
  [/\$queryRaw|\$executeRaw/, 'runs raw SQL'],
];

/**
 * `src` with every comment blanked to spaces (newlines kept, so offsets and line numbers hold).
 * A lexer, not a regex: it skips single- and double-quoted strings, template literals (with `${…}`
 * nesting) and regular-expression literals, so a glob string such as 'packages/*' + '/src' no
 * longer opens a "comment" that hides everything up to the next star-slash, and a trailing `// …`
 * comment is removed without touching the code before it. Regular-expression detection is the
 * usual previous-token heuristic and is bounded to one line, so a wrong guess costs at most that
 * line. JSX text containing a quote is bounded the same way (a string ends at its line).
 */
export function stripComments(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') {
        out[k] = ' ';
      }
    }
  };
  const regexAfterWord = new Set([
    'return',
    'typeof',
    'case',
    'do',
    'else',
    'in',
    'of',
    'void',
    'delete',
    'throw',
    'new',
    'await',
    'yield',
  ]);
  const skipString = (from) => {
    const quote = src[from];
    let i = from + 1;
    while (i < n && src[i] !== '\n') {
      if (src[i] === '\\') {
        i += 2;
      } else if (src[i] === quote) {
        return i + 1;
      } else {
        i++;
      }
    }
    return Math.min(i, n);
  };
  const skipRegex = (from) => {
    let inClass = false;
    for (let i = from + 1; i < n && src[i] !== '\n'; i++) {
      if (src[i] === '\\') {
        i++;
      } else if (src[i] === '[') {
        inClass = true;
      } else if (src[i] === ']') {
        inClass = false;
      } else if (src[i] === '/' && !inClass) {
        return i + 1;
      }
    }
    return from + 1; // no closing slash on this line: it was a division
  };
  let template;
  const code = (from, inInterpolation) => {
    let i = from;
    let depth = 0;
    let prev = '';
    let prevWord = '';
    while (i < n) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '/' && d === '/') {
        let j = src.indexOf('\n', i);
        j = j < 0 ? n : j;
        blank(i, j);
        i = j;
      } else if (c === '/' && d === '*') {
        const j = src.indexOf('*/', i + 2);
        const end = j < 0 ? n : j + 2;
        blank(i, end);
        i = end;
      } else if (c === "'" || c === '"') {
        i = skipString(i);
        prev = '"';
        prevWord = '';
      } else if (c === '`') {
        i = template(i + 1);
        prev = '`';
        prevWord = '';
      } else if (c === '/') {
        const regexAllowed =
          prev === '' || '(,=:[!&|?{};+-*%<>~^}'.includes(prev) || regexAfterWord.has(prevWord);
        i = regexAllowed ? skipRegex(i) : i + 1;
        prev = '/';
        prevWord = '';
      } else if (/[\w$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(src[j])) {
          j++;
        }
        prevWord = src.slice(i, j);
        prev = 'a';
        i = j;
      } else {
        if (c === '{') {
          depth++;
        } else if (c === '}') {
          if (inInterpolation && depth === 0) {
            return i + 1;
          }
          depth--;
        }
        if (!/\s/.test(c)) {
          prev = c;
          prevWord = '';
        }
        i++;
      }
    }
    return i;
  };
  template = (from) => {
    let i = from;
    while (i < n) {
      if (src[i] === '\\') {
        i += 2;
      } else if (src[i] === '`') {
        return i + 1;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        i = code(i + 2, true);
      } else {
        i++;
      }
    }
    return i;
  };
  code(0, false);
  return out.join('');
}

function checkMcpCodeHasNoDatabaseAccess() {
  const files = [
    ...walk(MCP_CODE_DIR, (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
    MCP_ROUTE_FILE,
  ];
  const why =
    "MCP tools must reach data only through a REST route, by the bridge, so the route's role " +
    'check, visibility filter, tenant guard and audit apply to them. Direct access, or any module ' +
    'that has it, is a second, weaker permission path. Move the work to a route; if a new pure ' +
    'dependency is genuinely needed, add it to the allowlist in scripts/check-invariants.mjs.';
  for (const file of files) {
    const code = stripComments(read(file));
    for (const specifier of moduleSpecifiers(code)) {
      if (!importAllowed(file, specifier)) {
        const line = code
          .split('\n')
          .findIndex((l) => l.includes(specifier.replace(/^<computed:/, '')));
        fail(
          file,
          Math.max(line, 0) + 1,
          'mcp-no-database-access',
          `MCP code imports "${specifier}", which is not on the allowlist`,
          why
        );
      }
    }
    code.split('\n').forEach((text, i) => {
      for (const [pattern, what] of DATABASE_WORDS) {
        if (pattern.test(text)) {
          fail(file, i + 1, 'mcp-no-database-access', `MCP code ${what}`, why);
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// INVARIANT 5 — an outbound connector request states its redirect policy.
//
// Connector fetches carry a credential to an operator-supplied or fixed host. `fetch` follows
// redirects by default, so a call that says nothing lets a checked host bounce the request — and,
// for headers Node does not strip across origins, the credential — to a host nobody validated.
// Nothing fails: the request succeeds and returns data. The call must write `redirect` (`'error'`,
// or `'manual'` with its own per-hop check); GitHub Issues goes through `fetchGuarded`, which
// does it internally.
//
// This is a tripwire, not a proof: it reads source text for `fetch(` and `globalThis.fetch(`, so an
// aliased or injected fetch (`const f = fetch; f(…)`, a `fetchImpl` parameter, another HTTP
// client) is not seen. It catches the common omission, not a determined bypass. Scope:
// `shared/lib/integrations`, `worker/src/connectors`, and the SCM seam directory (see
// `scmProviderFiles`).
// ---------------------------------------------------------------------------

/** Violations in one file's source: the line of each `fetch(…)` call that states no `redirect`. */
export function connectorFetchRedirectViolations(source) {
  const found = [];
  const src = stripComments(source);
  for (const m of src.matchAll(/(?:(?<![.\w])|\bglobalThis\.)fetch\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const init = callArgs(src, open)[1] ?? '';
    if (!/\bredirect\b/.test(init)) {
      found.push({ line: src.slice(0, open).split('\n').length });
    }
  }
  return found;
}

function checkConnectorFetchesSetRedirect() {
  const files = [
    ...walk(
      'packages/shared/src/lib/integrations',
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
    ),
    ...walk('packages/worker/src/connectors', (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
    ...scmProviderFiles(),
  ];
  for (const file of files) {
    for (const v of connectorFetchRedirectViolations(read(file))) {
      fail(
        file,
        v.line,
        'connector-fetch-sets-redirect',
        'a connector fetch(…) call does not set `redirect`',
        "Default `fetch` follows redirects, so a credentialed request can be bounced to an unchecked host. Add `redirect: 'error'`, or follow hops by hand with a check on each (see fetchGuarded)."
      );
    }
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 7 — a fetch to an operator-supplied URL resolves and pins its address.
//
// The text guard (`ssrfGuard.ts`) reads the host name only, so a public name that resolves to an
// internal address passes it. `createGuardedFetch` (`shared/lib/guardedDispatcher.ts`) resolves the
// name, refuses the request if any answer is internal, and connects only to a checked address. In
// the modules below every outbound request is to such a URL, so a bare `fetch(…)` there is the
// text-only check again: it type-checks, the tests pass against a stubbed fetch, and a request to
// `10.1.1.17.nip.io` reaches the internal host.
//
// Tripwire over text, scoped to files whose every request is operator-supplied (a module that also
// calls a fixed public host, such as the issue-tracker connector's Linear call, is not listed and
// is reviewed by hand). It sees `fetch(…)`, `globalThis.fetch(…)`, and `fetch` used as a VALUE — a
// `= fetch` default parameter, `fetch` passed as an argument — because an injectable fetch that
// defaults to the bare one is the same bypass. `typeof fetch` (a type) and a `fetch:` property key
// are not flagged.
//
// Covered: the modules listed below, plus every source file in `worker/src/lib/scm/` other than
// `types.ts` and `index.ts` (globbed by directory, so a future provider file is covered the day it
// is added). In `scm/github.ts` the Octokit and GitHub Enterprise calls do not go through `fetch`
// and are documented exclusions, and the one request that does (the CI log download) goes through
// `fetchGuarded`. Not covered: an aliased
// fetch (`const f = globalThis['fetch']`), another HTTP client, and the modules that mix fixed and
// operator-supplied hosts (reviewed by hand).
// ---------------------------------------------------------------------------

const GUARDED_FETCH_MODULES = [
  'packages/gateway/src/lib/bundleFetch.ts',
  'packages/gateway/src/lib/credentialService.ts',
  'packages/gateway/src/lib/mcpProbe.ts',
  'packages/shared/src/lib/modelDiscovery.ts',
  'packages/shared/src/lib/modelPriceList.ts',
  'packages/shared/src/lib/integrations/atlassianClient.ts',
  'packages/shared/src/lib/integrations/providers/githubIssues.ts',
  'packages/shared/src/lib/skillSource/github.ts',
  'packages/worker/src/agents/claudeCode/modelProxy.ts',
  'packages/worker/src/lib/registryProxy/index.ts',
  'packages/worker/src/agents/mcpTools.ts',
  'packages/worker/src/lib/callbackSender.ts',
  // Every file under packages/worker/src/lib/scm/ is covered too (scmProviderFiles()).
];

/**
 * Violations in one file's source: the line of each bare `fetch` (call, default parameter or
 * passed value).
 */
export function bareFetchViolations(source) {
  const found = [];
  // Strings are blanked too, so prose such as 'Cannot fetch CI logs' is not read as code. Line
  // numbers survive: only the characters between the quotes are removed.
  const src = stripComments(source).replace(
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    (str) => str[0] + str.slice(1, -1).replace(/[^\n]/g, ' ') + str[str.length - 1]
  );
  for (const m of src.matchAll(/(?:(?<![.\w])|\bglobalThis\.)fetch\b/g)) {
    const before = src.slice(0, m.index);
    if (/\btypeof\s+$/.test(before)) {
      continue;
    }
    // A property key (`{ fetch: x }`, `, fetch?: T`) follows `{` or `,`; `cond ? fetch : x` does not.
    if (/^\??\s*:/.test(src.slice(m.index + m[0].length)) && /[{,]\s*$/.test(before)) {
      continue;
    }
    found.push({ line: before.split('\n').length });
  }
  return found;
}

function checkOperatorUrlFetchesAreGuarded() {
  for (const file of [...GUARDED_FETCH_MODULES, ...scmProviderFiles()]) {
    for (const v of bareFetchViolations(read(file))) {
      fail(
        file,
        v.line,
        'operator-url-fetch-is-guarded',
        'a bare fetch (call, default parameter or passed value) in a module whose requests go to operator-supplied URLs',
        'The text guard does not resolve DNS, so a public name that resolves to an internal address ' +
          'reaches it. Use createGuardedFetch() from shared/lib/guardedDispatcher.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 6 — every opt-in test suite runs in CI, with its opt-in flag set.
//
// A `*.pg.test.ts` suite writes to a real database and a `*.docker.test.ts` suite drives a real
// container; the unit-test job has neither, so each gates itself on an environment flag
// (`describe.skipIf(!enabled)`) and a named step of `ci.yml` runs it with that flag set. Two
// mistakes would be invisible: a new suite that no step lists is never run anywhere, and a suite
// listed under the wrong flag has every test skipped by its own gate. Both leave CI green — a
// skipped suite and an absent suite report the same thing. A step with `if:` or
// `continue-on-error:` can skip or swallow a suite the same way.
//
// Like the MCP rule, this is a standing constraint, not a past incident: no unlisted suite has
// reached main, the gap was caught twice in review.
//
// A tripwire over text, not a YAML parser: `ci.yml` is regular enough for a line scan. A flag set
// on a job or workflow `env:` instead of the step is not seen, and a suite whose gate is not the
// `process.env.X === '1'` form is refused rather than guessed at. A renamed suite needs no rule of
// its own: its old path stops matching a file, so it is reported as not run by any step.
// ---------------------------------------------------------------------------

const CI_WORKFLOW = '.github/workflows/ci.yml';
const RULE = 'opt-in-suites-run-in-ci';
/** The suffixes of suites that skip themselves without their flag. */
const OPT_IN_SUITE = /\.(?:pg|docker)\.test\.ts$/;

// Live suites (`*.live.test.ts`) talk to real services with real credentials, so they run from
// their own workflow, never from `ci.yml` (which runs on pull requests, forks included). The same
// rule holds for them there: a step names the suite, sets its flag, and carries no `if:`.
const LIVE_WORKFLOW = '.github/workflows/live-e2e.yml';
const LIVE_RULE = 'live-suites-run-in-live-workflow';
const LIVE_SUITE = /\.live\.test\.ts$/;

/** Where each kind of opt-in suite must be run from, and how a step names one. */
const CI_TARGET = {
  pattern: /packages\/[^\s'"]+\.(?:pg|docker)\.test\.ts/g,
  rule: RULE,
  workflow: CI_WORKFLOW,
};
const LIVE_TARGET = {
  pattern: /packages\/[^\s'"]+\.live\.test\.ts/g,
  rule: LIVE_RULE,
  workflow: LIVE_WORKFLOW,
};

/** Each workflow step as `{ line, text }`, the slice from its `- key:` line to the next one. */
function workflowSteps(yml) {
  const steps = [];
  yml.split('\n').forEach((text, i) => {
    if (/^\s*- [A-Za-z]\w*:/.test(text)) {
      steps.push({ line: i + 1, text: '' });
    }
    if (steps.length > 0) {
      steps[steps.length - 1].text += `${text}\n`;
    }
  });
  return steps;
}

/**
 * The violations of invariant 6 for `suites` (`{ path, src }`, repo-relative) against the text of
 * `ci.yml`. Pure, so the rule is tested without touching the repository.
 */
export function optInSuiteViolations(suites, ciYml, target = CI_TARGET) {
  const workflow = target.workflow;
  const out = [];
  const add = (file, line, detail, why) =>
    out.push({ detail, file, invariant: target.rule, line, why });
  const named = new Map(); // suite path -> the steps whose `yarn test` line names it
  for (const step of workflowSteps(ciYml)) {
    const lines = step.text.split('\n');
    const runs = lines.filter((l) => !l.trim().startsWith('#') && l.includes('yarn test'));
    for (const path of runs.join('\n').match(new RegExp(target.pattern)) ?? []) {
      named.set(path, [...(named.get(path) ?? []), { ...step, lines }]);
    }
  }

  for (const { path: file, src } of suites) {
    const runners = named.get(file);
    if (!runners) {
      add(
        file,
        1,
        `${file} is not run by any \`yarn test\` step in ${workflow}`,
        'Opt-in suites skip themselves in the unit-test job, so a suite no step names never ' +
          'runs anywhere while CI stays green. Add a step that sets its flag.'
      );
      continue;
    }
    // The gates: every `process.env.X === '1'` in the code, not in its doc comment.
    const gates = [...stripComments(src).matchAll(/process\.env\.(\w+)\s*===\s*'1'/g)];
    if (gates.length === 0) {
      add(
        file,
        1,
        "cannot find the suite's opt-in gate (`process.env.X === '1'`)",
        'Without knowing which flag it gates on, the check cannot tell whether CI sets it, and a ' +
          'step with the wrong flag is green with every test skipped. Gate it in that form, or teach this rule the new one.'
      );
      continue;
    }
    for (const step of runners) {
      for (const [, flag] of gates) {
        if (
          !step.lines.some((l) => new RegExp(`^\\s+${flag}:\\s*['"]?1['"]?\\s*(#.*)?$`).test(l))
        ) {
          add(
            workflow,
            step.line,
            `the step running ${file} does not set ${flag}: '1'`,
            `The suite skips every test unless ${flag}=1, and a skipped suite is a passing step.`
          );
        }
      }
      if (step.lines.some((l) => /^\s+(?:- )?(?:if|continue-on-error):/.test(l))) {
        add(
          workflow,
          step.line,
          `the step running ${file} has \`if:\` or \`continue-on-error:\``,
          'A condition can skip the suite and continue-on-error swallows its failure; either way the step stays green.'
        );
      }
    }
  }
  return out;
}

function checkOptInSuitesRunInCi() {
  const suites = walk('packages', (f) => OPT_IN_SUITE.test(f)).map((path) => ({
    path,
    src: read(path),
  }));
  failures.push(...optInSuiteViolations(suites, read(CI_WORKFLOW)));
}

/** The triggers named under a workflow's top-level `on:` key (block form); null without one. */
export function workflowTriggers(yml) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^on:\s*(#.*)?$/.test(l));
  if (start < 0) {
    return null;
  }
  const triggers = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) {
      break;
    }
    const m = /^ {2}([A-Za-z_]+):/.exec(line);
    if (m) {
      triggers.push(m[1]);
    }
  }
  return triggers;
}

const LIVE_FORBIDDEN_TRIGGERS = ['pull_request', 'pull_request_target', 'push', 'workflow_call'];

/**
 * The violations of the live-suite rule: every `*.live.test.ts` is run by a step of
 * `live-e2e.yml`, and that workflow starts only on a schedule or by hand. A pull-request, push or
 * reusable-workflow trigger would hand secrets to a run an outsider can shape, or spend them on
 * every commit, and a live suite would no longer be opt-in. Pure, like the rule above.
 */
export function liveSuiteViolations(suites, liveYml) {
  const out = optInSuiteViolations(suites, liveYml, LIVE_TARGET);
  const add = (detail, why) =>
    out.push({ detail, file: LIVE_WORKFLOW, invariant: LIVE_RULE, line: 1, why });
  if (suites.length === 0 && liveYml === '') {
    return out;
  }
  const triggers = workflowTriggers(liveYml);
  if (triggers === null) {
    add(`${LIVE_WORKFLOW} has no \`on:\` block`, 'Without it the triggers cannot be checked.');
    return out;
  }
  for (const t of triggers.filter((x) => LIVE_FORBIDDEN_TRIGGERS.includes(x))) {
    add(
      `${LIVE_WORKFLOW} is triggered by \`${t}\``,
      'The workflow holds real credentials and spends real money: it runs on a schedule or on ' +
        'demand only, never for a pull request, a push or a caller.'
    );
  }
  for (const t of ['schedule', 'workflow_dispatch']) {
    if (!triggers.includes(t)) {
      add(
        `${LIVE_WORKFLOW} has no \`${t}\` trigger`,
        'Live checks run on a schedule and on demand; without both, either nothing runs them ' +
          'regularly or nobody can run one by hand.'
      );
    }
  }
  return out;
}

function checkLiveSuitesRunInLiveWorkflow() {
  const suites = walk('packages', (f) => LIVE_SUITE.test(f)).map((path) => ({
    path,
    src: read(path),
  }));
  const yml = existsSync(join(ROOT, LIVE_WORKFLOW)) ? read(LIVE_WORKFLOW) : '';
  failures.push(...liveSuiteViolations(suites, yml));
}

// ---------------------------------------------------------------------------
// INVARIANT 8 — a compose wrapper adds a profile; it never names one with `--profile`.
//
// Compose's `--profile` flag replaces `COMPOSE_PROFILES` instead of adding to it. The local
// scripts passed `--profile temporal-ui`, so `COMPOSE_PROFILES=objectstore` from `.env` was
// ignored and the bundled Garage store never started through `yarn docker:*` or `just`; the
// rest of the stack came up healthy without it, so nothing reported the missing service. The
// production teardown had the same flag and left Garage running.
//
// Rule: in the root `package.json` scripts and the `Justfile`, `--profile` may only take `'*'`
// (every profile, for a teardown). A profile a recipe needs goes through
// `node scripts/compose.mjs --add-profile <name>`, which keeps the configured ones.
// ---------------------------------------------------------------------------

const COMPOSE_ENTRY_FILES = ['package.json', 'Justfile'];

function checkComposeProfilesAreAdded() {
  for (const file of COMPOSE_ENTRY_FILES) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith('#')) {
        return;
      }
      for (const m of line.matchAll(/--profile(?:\s+|=)(\S+)/g)) {
        if (!/^['"]?\*['"]?$/.test(m[1].replace(/[",]+$/, ''))) {
          fail(
            file,
            i + 1,
            'compose-profiles-are-added',
            `\`--profile ${m[1]}\` names a Compose profile`,
            '`--profile` replaces COMPOSE_PROFILES, so the profiles .env enables (objectstore) are ' +
              "silently dropped. Use `node scripts/compose.mjs --add-profile <name>`, or `--profile '*'` for a teardown."
          );
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 9 — a credential reaches a workspace command through `secretEnv`, never `env`.
//
// Under the Kubernetes backend a `kubectl exec` command is sent as `?command=` query parameters,
// and the driver renders `env: string[]` into that command (`env NAME=value …`), so every pair in
// it lands in the apiserver audit log, kept for as long as the operator keeps those. Under Docker the
// same pair is a `docker run -e NAME=value` argument, visible in `ps` on the worker host. The safe
// channel is `secretEnv` (a name → value map the driver delivers on stdin / from the client's own
// environment). Both are `string`s to the type checker and a leaked token runs the command fine, so
// nothing fails: the git `http.extraheader` was embedded in a script this way and shipped.
//
// Rule: in worker source, an array literal assigned to `env` or `leadingEnv` (as a property,
// quoted or not, or as `x.env = [ … ]`) does not mention a credential-shaped name (TOKEN, SECRET,
// PASSWORD, API_KEY, AUTH, CREDENTIAL, NPMRC, YARNRC, PRIVATE_KEY, ACCESS_KEY, SSH_KEY, DEPLOY_KEY,
// SIGNING_KEY, BEARER, COOKIE, PASSPHRASE, and PAT, PASS or PWD as a whole word), in a string or an
// identifier. The source rule scans the whole list text, so a value or identifier containing a
// whole-word PAT, PASS or PWD (e.g. `MODE=pass`) is also flagged; that is a CI failure, never a
// production error.
// `AUTHOR` (but not `AUTHORIZATION`) and `TOKENS` (GIT_AUTHOR_NAME, MAX_OUTPUT_TOKENS) are not
// credentials.
//
// A tripwire over text, not a proof. It does not see an `env` built elsewhere and passed by name
// (`opts.env.push(…)`, `base.concat([…])`, `cond ? […] : […]`, a `[...registry.env]` spread), an
// object-valued `env` (the ephemeral container spec's `env: Record`), a secret whose name is
// innocuous (`SERVICE_LOGIN`), a trailing `//` comment inside the list (a false positive), a `]`
// inside a regex literal or nested template in the list (the scanner closes the list early), or a
// script or argv that interpolates a credential into its own text. Those are reviewed by hand.
// ---------------------------------------------------------------------------

const CREDENTIAL_NAME = new RegExp(
  [
    /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH|CREDENTIAL|NPMRC|YARNRC/,
    /(?:PRIVATE|ACCESS|SSH|DEPLOY|SIGNING)_?KEY|BEARER|COOKIE|PASSPHRASE/,
    /(?<![A-Za-z0-9])(?:PAT|PASS|PWD)(?![A-Za-z])/,
  ]
    .map((re) => re.source)
    .join('|'),
  'i'
);

/** `env: [`, `'env': [`, `leadingEnv: [` or `x.env = [` — the start of an env list literal. */
const ENV_LIST =
  /(?:(?<![.\w])['"]?(?:env|leadingEnv)['"]?\s*:|\.(?:env|leadingEnv)\s*=(?!=))\s*\[/g;

/** Names that contain a credential word without being one. */
const NOT_A_CREDENTIAL = /AUTHOR(?!IZ)|TOKENS(?![A-Za-z])/gi;

/** The source of the bracket-balanced array whose `[` is at `open`. */
function arraySlice(src, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') {
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
    } else if (c === '[') {
      depth++;
    } else if (c === ']' && --depth === 0) {
      return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/** Violations in one file's source: `{ line, text }` per credential-shaped `env: [ … ]` list. */
export function envCredentialViolations(src) {
  const code = stripComments(src);
  const found = [];
  for (const m of code.matchAll(ENV_LIST)) {
    const open = m.index + m[0].length - 1;
    const list = arraySlice(code, open);
    if (CREDENTIAL_NAME.test(list.replace(NOT_A_CREDENTIAL, ''))) {
      found.push({ line: code.slice(0, open).split('\n').length, text: list.replace(/\s+/g, ' ') });
    }
  }
  return found;
}

function checkCredentialsAreNotInEnv() {
  const files = walk('packages/worker/src', (f) => f.endsWith('.ts') && !/\.test\.ts$/.test(f));
  for (const file of files) {
    for (const v of envCredentialViolations(read(file))) {
      fail(
        file,
        v.line,
        'credential-not-in-env',
        `an \`env: [ … ]\` list names a credential: ${v.text.slice(0, 120)}`,
        'Under Kubernetes the env pairs are part of the exec command, which the apiserver audit log ' +
          'records; under Docker they are `-e NAME=value` argv. Pass the value as `secretEnv` ' +
          '(see WorkspaceExecOptions / HelperContainerSpec) and read it from the environment.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 10 — nothing merges a pull request immediately.
//
// The platform opens pull requests and humans merge them. The one merge-capable path is
// `enablePullRequestAutoMerge` (the SCM provider's `enableAutoMerge`), which only asks the host
// to merge once the host's own branch protection is satisfied, and only for the head commit that
// was evaluated. An immediate merge would bypass that: `pulls.merge` / `repos.merge` (also
// written `pulls['merge'](`), the REST `…/pulls/N/merge` and `POST …/merges` routes, the
// `mergePullRequest`, `mergeBranch` and `enqueuePullRequest` GraphQL mutations, or a literal
// `git push … HEAD:main` / `HEAD:master` refspec. The GitLab and Bitbucket spellings are covered
// the same way: the REST routes `…/merge_requests/<id>/merge` and `…/pullrequests/<id>/merge`
// (also `pull-requests`; literal, `{id}` or `${id}` forms), `merge_when_pipeline_succeeds` /
// `mergeWhenPipelineSucceeds`, `accept_merge_request`, `acceptMergeRequest`, `mergeMergeRequest`,
// the GraphQL `mergeRequestAccept`, and a `mergeRequests` / `pullrequests` client's `.merge(` or
// `.accept(`. Each type-checks and works, so nothing else fails when one is added.
//
// Covered beyond GitHub and the first GitLab/Bitbucket spellings: `git push … main|master|trunk|
// develop|development` and `git push … <src>:<those>` (also `+`/`--force`, and an interpolated
// default branch such as the template spelling of `HEAD:` followed by `defaultBranch`), the same
// pushes written as an argv array (`['push', 'origin', 'HEAD:main']`), Gerrit's
// `…/changes/<id>/submit` and `…/revisions/<rev>/submit`, Azure DevOps
// `…/pullrequests/<id>` bodies that set `status` to `completed` (and `PullRequestStatus.Completed`,
// `updatePullRequest`), and a singular `mergeRequest.merge(`. Adjacent lines are joined where a
// `${…}` interpolation breaks across them, so a template literal wrapped inside its braces is
// still read as one route.
//
// Read-only lookalikes are not flagged: `…/merge_requests/<id>/merge-base` and `…/merge_ref`, the
// Bitbucket `…/pullrequests/<id>/merge/task-status/<id>`, and a route that the call text shows is a
// GET (`'GET /repos/…/pulls/N/merge'`, `.get(…/merge)`, `{ method: 'GET' }` — GitHub's is-merged
// check and Bitbucket Server's can-merge check). The GET test reads the characters around the route
// only; a method held in a variable is not seen, so such a read is flagged and the author names
// the provider file in the allowlist below or rewrites the call.
//
// The allowlist below is empty. A future provider that implements opt-in auto-merge adds its single
// file (under `scm/`) to `IMMEDIATE_MERGE_PROVIDER_ALLOWLIST` deliberately, mirroring
// `enableAutoMerge` in `scm/github.ts` (and, with it, the `enableAutoMerge` naming rule below). It
// exempts that file from the non-GitHub spellings only (GitLab, Bitbucket, Gerrit, Azure, Gitea);
// the GitHub spellings and the `git push` refspec rules are never exempt. Reading GitLab's
// `merge_when_pipeline_succeeds` response field also trips the rule for any other file; that is
// accepted until such a provider exists.
//
// A tripwire over source text with comments removed: it matches those spellings only. An aliased
// client, a route or refspec built from pieces (`base + '/merge'`, `.join('/')`), a method or path
// held in a variable and any other merge mechanism are not seen, so it is a floor, not proof that
// nothing merges. Like the MCP rule, a standing constraint rather than a past incident.
// ---------------------------------------------------------------------------

// A run of path characters: anything but whitespace and quotes, or a `${…}` interpolation (which
// may itself contain spaces: `${a + b}`).
const PATH_RUN = String.raw`(?:\$\{[^}\n]*\}|[^'"\x60\s$]|\$(?!\{))*`;
const MR_CLIENT = `(?:merge_requests|mergeRequests|MergeRequests|mergeRequest|MergeRequest|pullrequests|pullRequests|PullRequests|pullrequest|pullRequest|PullRequest)`;
// A default-branch name, or an interpolated/variable default branch, as a push destination.
const DEFAULT_BRANCH_NAME = String.raw`(?:refs\/heads\/)?(?:(?:main|master|trunk|develop|development)(?![\w/.-])|\$\{[^}\n]*(?:[dD]efault|[bB]ase)_?[bB]ranch[^}\n]*\}|\$\{?[A-Z_]*DEFAULT_BRANCH\b\}?)`;
// One character of a shell command: anything but a command separator.
const SHELL_ARG = String.raw`[^\n;&|]`;
const DEFAULT_BRANCH_ARGV = String.raw`(?:[^'"\x60\s:]*:)?${DEFAULT_BRANCH_NAME}`;

/**
 * Rules as `{ re, route, provider }`. `route` rules read a URL, so a visible GET exempts them;
 * `provider` rules are the non-GitHub spellings an allowlisted provider file may use.
 */
const MERGE_RULES = [
  // GitHub
  { re: String.raw`\b(?:pulls|repos)\s*\.\s*merge\s*\(` },
  { re: String.raw`\b(?:pulls|repos)\s*\[\s*['"\x60]merge['"\x60]\s*\]\s*\(` },
  { re: String.raw`\b(?:mergePullRequest|mergeBranch|enqueuePullRequest)\b` },
  // The GitHub REST spellings are never exempt, not even for a visible GET: nothing in the tree
  // reads them, and a read-looking context is exactly what a disguised PUT would borrow.
  { re: String.raw`\/pulls\/${PATH_RUN}\/merge(?![\w-])` },
  { re: String.raw`\/repos\/${PATH_RUN}\/merges(?![\w-])` },
  // A literal push of a default branch: `HEAD:main`, `+x:refs/heads/master`, a bare `main`
  // destination, or an interpolated default branch. `shell` rules run on the source with every
  // quote and backtick removed, so `'HEAD':'main'`, a `git -c … push`, a `git -C dir push` and a
  // bare `gitAuthed(\`push origin HEAD:main\`)` all read as one command. A command ends at a shell
  // separator (`;`, `&`, `|`) or the line end, so `git push origin x && git checkout main` is clean.
  // `push` is not preceded by `.` or a word character, so `list.push(a, main)` is not a push.
  {
    re: String.raw`(?<![.\w$-])push\s+${SHELL_ARG}*?[\s+][^\s:;&|]*:${DEFAULT_BRANCH_NAME}`,
    shell: true,
  },
  {
    re: String.raw`(?<![.\w$-])push(?=\s)${SHELL_ARG}*?\s${DEFAULT_BRANCH_NAME}`,
    shell: true,
  },
  // The same push as an argv array. Newlines are allowed up to the closing bracket.
  {
    re: String.raw`['"\x60]push['"\x60]\s*,[^\]]*?['"\x60]${DEFAULT_BRANCH_ARGV}['"\x60]`,
  },
  {
    re: String.raw`['"\x60]push['"\x60]\s*,[^\]]*?['"\x60]\s*,\s*(?:[\w.]*\.)?(?:default|base)Branch\s*[,\]]`,
  },
  // GitLab and Bitbucket. A `…/merge_requests/<id>/cancel_merge_when_pipeline_succeeds` route is
  // not matched: the segment must be exactly `/merge`, and the option name starts at a word edge.
  // `/merge-base`, `/merge_ref` and Bitbucket's `/merge/task-status/…` are reads.
  {
    provider: true,
    re: String.raw`\/(?:merge_requests|pullrequests|pull-requests)\/${PATH_RUN}\/merge(?![\w-])(?!\/task-status)`,
    route: true,
  },
  {
    provider: true,
    re: String.raw`\b(?:merge_when_pipeline_succeeds|mergeWhenPipelineSucceeds)\b`,
  },
  {
    provider: true,
    re: String.raw`\b(?:accept_merge_request|acceptMergeRequest|merge_merge_request|mergeMergeRequest|mergeRequestAccept)\b`,
  },
  { provider: true, re: String.raw`\b${MR_CLIENT}\s*\.\s*(?:merge|accept)\s*\(` },
  {
    provider: true,
    re: String.raw`\b${MR_CLIENT}\s*\[\s*['"\x60](?:merge|accept)['"\x60]\s*\]\s*\(`,
  },
  // Gerrit: `POST /changes/<id>/submit` and `/revisions/<rev>/submit` (`submit_preview` and
  // `submitted_together` are reads and do not match).
  {
    provider: true,
    re: String.raw`\/(?:changes|revisions)\/${PATH_RUN}\/submit(?![\w-])`,
    route: true,
  },
  // Azure DevOps: completing a pull request is a PATCH of `pullrequests/<id>` with
  // `status: 'completed'`, or the client's `updatePullRequest`.
  // `updatePullRequest` is also GitHub's non-merging GraphQL mutation, so the name counts only
  // beside Azure's completing shape (`status: completed` or the enum's `3`, `PullRequestStatus.Completed`,
  // `completionOptions`) within 400 characters either side.
  {
    provider: true,
    re: String.raw`\bupdatePullRequest\b[\s\S]{0,400}?(?:\bcompletionOptions\b|\bPullRequestStatus\s*\.\s*Completed\b|\bstatus['"\x60]?\s*[:=]\s*(?:['"\x60]?completed\b|3\b))`,
  },
  {
    provider: true,
    re: String.raw`(?:\bcompletionOptions\b|\bPullRequestStatus\s*\.\s*Completed\b|\bstatus['"\x60]?\s*[:=]\s*(?:['"\x60]?completed\b|3\b))[\s\S]{0,400}?\bupdatePullRequest\b`,
  },
  { provider: true, re: String.raw`\bPullRequestStatus\s*\.\s*Completed\b` },
  {
    provider: true,
    re: String.raw`pullrequests\/[\s\S]{0,400}?\bstatus['"\x60]?\s*[:=]\s*['"\x60]?completed\b`,
  },
  {
    provider: true,
    re: String.raw`\bstatus['"\x60]?\s*[:=]\s*['"\x60]?completed\b[\s\S]{0,400}?pullrequests\/`,
  },
].map((r) => ({ ...r, re: new RegExp(r.re, 'g') }));

/**
 * Provider files allowed to name the non-GitHub merge spellings, as repo-relative paths under
 * `packages/worker/src/lib/scm/`. Empty: no provider implements opt-in auto-merge yet.
 */
export const IMMEDIATE_MERGE_PROVIDER_ALLOWLIST = new Set([]);

/** The index of the `(` that opens the innermost call enclosing `pos`, or -1. */
function enclosingCallOpen(flat, pos) {
  let depth = 0;
  for (let i = pos - 1; i >= Math.max(0, pos - 2000); i--) {
    const c = flat[i];
    if (c === ')') {
      depth++;
    } else if (c === '(') {
      if (depth === 0) {
        return i;
      }
      depth--;
    }
  }
  return -1;
}

/** The `method` values written as direct keys of an object-literal argument (`{ … }`). */
function topLevelMethods(arg) {
  const found = [];
  const text = arg.trim();
  if (!text.startsWith('{')) {
    return found;
  }
  let depth = 0;
  let prev = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      const m = depth === 1 && (prev === '{' || prev === ',') ? text.slice(i) : '';
      const key = /^(['"\x60])method\1\s*:\s*(['"\x60])(\w+)\2/.exec(m);
      if (key) {
        found.push(key[3].toUpperCase());
      } else if (/^(['"\x60])method\1\s*:/.test(m)) {
        found.push('?');
      }
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === '\\') {
          i++;
        }
      }
      prev = 'a';
      continue;
    }
    if (depth === 1 && (prev === '{' || prev === ',') && /[\w$]/.test(c)) {
      const m = /^method\s*:\s*(?:(['"\x60])(\w+)\1)?/.exec(text.slice(i));
      if (m) {
        found.push(m[2] ? m[2].toUpperCase() : '?');
      }
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++;
    } else if (c === '}' || c === ']' || c === ')') {
      depth--;
    }
    if (!/\s/.test(c)) {
      prev = /[\w$]/.test(c) ? 'a' : c;
    }
  }
  return found;
}

/**
 * Does the text around a non-GitHub route show that the request is a GET (a read, not a merge)?
 * Three spellings, each tied to the call that carries the route:
 *  - the route literal itself opens with the verb: `request('GET /…')`;
 *  - the enclosing call has exactly ONE `method` key among the direct keys of its object
 *    arguments, and it is a literal GET (`headers: { 'x-orig-method': 'GET' }` and
 *    `meta: { method: 'GET' }` are nested, so they count for nothing, and a second `method` key
 *    makes the call undecidable, so it is not exempt);
 *  - the enclosing call IS `….get(…)` and no write verb literal ('PUT', 'POST', …) precedes it in
 *    the call that wraps it.
 */
function looksLikeGet(flat, start) {
  const before = flat.slice(Math.max(0, start - 160), start);
  if (/['"\x60]\s*GET\s+[^'"\x60\s]*$/i.test(before)) {
    return true;
  }
  const open = enclosingCallOpen(flat, start);
  if (open < 0) {
    return false;
  }
  const methods = callArgs(flat, open).flatMap(topLevelMethods);
  if (methods.length > 0) {
    return methods.length === 1 && methods[0] === 'GET';
  }
  if (/\.\s*get\s*$/.test(flat.slice(Math.max(0, open - 20), open))) {
    const outer = enclosingCallOpen(flat, open);
    const wrapper = outer < 0 ? '' : flat.slice(outer, open);
    return !/['"\x60]\s*(?:PUT|POST|PATCH|DELETE)\b/i.test(wrapper);
  }
  return false;
}

/**
 * Violations in one file's source: `{ line, text }` per immediate-merge call. Pass the file's
 * repo-relative path to honour `IMMEDIATE_MERGE_PROVIDER_ALLOWLIST` (or an `allowlist` of your own).
 */
export function immediateMergeViolations(
  src,
  file = '',
  allowlist = IMMEDIATE_MERGE_PROVIDER_ALLOWLIST
) {
  const stripped = stripComments(src);
  // Newlines inside a `${…}` become spaces (same length), so a template literal that wraps inside
  // its interpolation is one route again and offsets still map to the same lines.
  const flat = stripped.replace(/\$\{[^}]*\}/g, (m) => m.replace(/\n/g, ' '));
  // The same text with quotes and backticks removed, for the rules that read a shell command.
  const shell = flat.replace(/['"\x60]/g, '');
  const lines = stripped.split('\n');
  const providerAllowed = file !== '' && allowlist.has(posixPath(file)) && isScmProviderFile(file);
  const hits = new Set();
  for (const rule of MERGE_RULES) {
    if (rule.provider && providerAllowed) {
      continue;
    }
    rule.re.lastIndex = 0;
    const text = rule.shell ? shell : flat;
    for (const m of text.matchAll(rule.re)) {
      if (rule.route && looksLikeGet(flat, m.index)) {
        continue;
      }
      hits.add(text.slice(0, m.index).split('\n').length);
    }
  }
  return [...hits]
    .sort((a, b) => a - b)
    .map((line) => ({ line, text: (lines[line - 1] ?? '').trim() }));
}

// The one merge-capable call, `enableAutoMerge` (GraphQL `enablePullRequestAutoMerge`), is named
// in exactly three source files: the GitHub provider that sends it, the provider interface, and
// the evaluation activity that decides whether to. A new caller would arm auto-merge without the
// evaluation's gates. The same tripwire caveats apply: a name assembled from pieces or reached
// through an alias is not seen.
export const AUTO_MERGE_NAMERS = new Set([
  'packages/worker/src/activities/evaluatePullRequest.ts',
  'packages/worker/src/lib/scm/github.ts',
  'packages/worker/src/lib/scm/types.ts',
]);
const AUTO_MERGE_NAME = /\b(?:enableAutoMerge|enablePullRequestAutoMerge)\b/;

/** Violations in one file's source (comments removed); empty for a file allowed to name it. */
export function autoMergeNamingViolations(file, src) {
  if (AUTO_MERGE_NAMERS.has(file.split(sep).join('/'))) {
    return [];
  }
  const found = [];
  stripComments(src)
    .split('\n')
    .forEach((text, i) => {
      if (AUTO_MERGE_NAME.test(text)) {
        found.push({ line: i + 1, text: text.trim() });
      }
    });
  return found;
}

function checkNoImmediateMerge() {
  const files = [];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    if (existsSync(join(ROOT, 'packages', pkg, 'src'))) {
      files.push(
        ...walk(join('packages', pkg, 'src'), (f) => SOURCE_EXTENSION.test(f) && !TEST_FILE.test(f))
      );
    }
  }
  for (const file of files) {
    const src = read(file);
    for (const v of autoMergeNamingViolations(file, src)) {
      fail(
        file,
        v.line,
        'no-immediate-merge',
        `names the auto-merge mutation outside its allowed files: ${v.text.slice(0, 120)}`,
        'Only the worker SCM provider (scm/github.ts, scm/types.ts) and the evaluation activity ' +
          '(activities/evaluatePullRequest.ts) may name enableAutoMerge or ' +
          'enablePullRequestAutoMerge; any other caller would arm auto-merge without the ' +
          "evaluation's gates. If a new caller is genuinely needed, route it through the activity."
      );
    }
    for (const v of immediateMergeViolations(src, file)) {
      fail(
        file,
        v.line,
        'no-immediate-merge',
        `an immediate merge call: ${v.text.slice(0, 120)}`,
        'Humans merge pull requests. The only merge-capable path is enableAutoMerge in the SCM ' +
          'provider (enablePullRequestAutoMerge with expectedHeadOid), which the host completes ' +
          'only once its own protection is satisfied.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 11 — a message reaches Slack only through a known writer, and the worker's writer
// defuses broadcast mentions.
//
// Text a model writes is posted to Slack as written, and a prompt-injected channel message can make
// it carry `<!channel>`. The worker's `lib/slackNotify.ts` defuses broadcast mentions
// (`neutralizeSlackBroadcasts`) at each place it sends to `chat.postMessage` / `chat.update`, so
// every caller is covered without remembering to ask. A new file that calls those endpoints itself
// would bypass that, and it type-checks, authenticates and posts fine, so nothing else fails.
//
// Rule 1: only the known writer files name `chat.postMessage` or `chat.update`. The worker's
// writer, the gateway's (`lib/slack.ts`, whose text is built by fixed code with outside text
// escaped, and `lib/hitlSlackSync.ts`, the same for an edit in place) and the workflow Slack-write
// connector node (`connectors/slack.ts`, whose content the workflow author chooses).
// Rule 2: in `slackNotify.ts`, every `fetch(SLACK_POST_URL` / `fetch(SLACK_UPDATE_URL` is matched by
// a `neutralizeSlackBroadcasts(` call, counted, so a new send in that file cannot skip it.
//
// A tripwire over source text with comments removed: an endpoint path assembled from pieces, an
// aliased URL constant in another file and a count satisfied by an unrelated call are not seen.
// A standing constraint on a new surface, not a past incident.
// ---------------------------------------------------------------------------

export const SLACK_MESSAGE_WRITERS = new Set([
  'packages/gateway/src/lib/hitlSlackSync.ts',
  'packages/gateway/src/lib/slack.ts',
  'packages/worker/src/connectors/slack.ts',
  'packages/worker/src/lib/slackNotify.ts',
]);
const SLACK_MESSAGE_ENDPOINT = /chat\.(?:postMessage|update)\b/;
const WORKER_SLACK_WRITER = 'packages/worker/src/lib/slackNotify.ts';

/** Violations in one file's source (comments removed): `{ line, text, kind }` each. */
export function slackWriterViolations(file, src) {
  const path = file.split(sep).join('/');
  const code = stripComments(src);
  const found = [];
  if (!SLACK_MESSAGE_WRITERS.has(path)) {
    code.split('\n').forEach((text, i) => {
      if (SLACK_MESSAGE_ENDPOINT.test(text)) {
        found.push({ kind: 'unknown-writer', line: i + 1, text: text.trim() });
      }
    });
  }
  if (path === WORKER_SLACK_WRITER) {
    const sends = (code.match(/\bfetch\(\s*SLACK_(?:POST|UPDATE)_URL\b/g) ?? []).length;
    const defused = (code.match(/\bneutralizeSlackBroadcasts\(/g) ?? []).length;
    if (defused < sends) {
      found.push({
        kind: 'unneutralized-send',
        line: 1,
        text: `${sends} send(s) to chat.postMessage / chat.update but only ${defused} neutralizeSlackBroadcasts( call(s)`,
      });
    }
  }
  return found;
}

function checkSlackMessageWriters() {
  const files = [];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    if (existsSync(join(ROOT, 'packages', pkg, 'src'))) {
      files.push(
        ...walk(
          join('packages', pkg, 'src'),
          (f) => SOURCE_EXTENSION.test(f) && !TEST_FILE.test(f) && !f.includes('generated')
        )
      );
    }
  }
  for (const file of files) {
    for (const v of slackWriterViolations(file, read(file))) {
      fail(
        file,
        v.line,
        'slack-message-writers',
        v.kind === 'unknown-writer'
          ? `posts or edits a Slack message outside the known writers: ${v.text.slice(0, 120)}`
          : v.text,
        v.kind === 'unknown-writer'
          ? "Send through the worker's lib/slackNotify.ts, which defuses <!channel>, <!here>, " +
              '<!everyone> and user-group mentions in text a model wrote. If another writer is ' +
              'genuinely needed, add it to SLACK_MESSAGE_WRITERS here and give it the same check.'
          : 'Every send in slackNotify.ts must pass its text through neutralizeSlackBroadcasts.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// INVARIANT 12 — another SCM provider's network code lives in `worker/src/lib/scm/`.
//
// The SCM seam's rules (bare-fetch, redirect policy, merge spellings, file globbing) are scoped to
// `packages/worker/src/lib/scm/`. A GitLab, Bitbucket, Gitea, Azure DevOps or Gerrit client written
// anywhere else — a gateway route, a shared helper — type-checks, authenticates and works, and
// escapes every one of them: it can use a bare `fetch`, follow redirects with a credential and
// merge. This is a tripwire for the common spellings: a REST path or SDK import that only a
// non-GitHub provider client has (`/api/v4/`, `/2.0/repositories`, `/rest/api/1.0`, `gitbeaker`,
// a `bitbucket` package import, `merge_requests` paths, `api.bitbucket.org`, `dev.azure.com`,
// `_apis/git`, the Gitea `/api/v1/repos/` and Gerrit `/a/changes/` routes).
//
// A tripwire over source text with comments removed (tests excluded): a base path assembled from
// pieces, a client reached through a name that avoids these tokens and any other HTTP client are
// not seen. Files in `PROVIDER_CODE_ALLOWLIST` may name the tokens; it is empty, and a file belongs
// on it only with a stated reason. A standing constraint on a new surface, not a past incident.
// ---------------------------------------------------------------------------

const PROVIDER_API_TOKENS = [
  /\/api\/v4\//,
  /\/2\.0\/repositories/,
  /\/rest\/api\/1\.0/,
  /gitbeaker/i,
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:bitbucket|bitbucket\/[^'"]*)['"]/,
  /\bmerge_requests\b/,
  /api\.bitbucket\.org/,
  /dev\.azure\.com/,
  /_apis\/git/,
  /azure-devops-node-api/,
  /\/api\/v1\/repos\//,
  /\/a\/changes\//,
];

/** Files outside `scm/` allowed to name a provider API token, each with a reason. Empty. */
export const PROVIDER_CODE_ALLOWLIST = new Set([]);

/** Violations in one file (repo-relative path) and its source: `{ line, text }` per hit. */
export function providerCodeOutsideScmViolations(file, src, allowlist = PROVIDER_CODE_ALLOWLIST) {
  const f = posixPath(file);
  if (f.startsWith(`${SCM_DIR}/`) || allowlist.has(f) || /\.(?:test|spec)\./.test(f)) {
    return [];
  }
  const found = [];
  stripComments(src)
    .split('\n')
    .forEach((text, i) => {
      if (PROVIDER_API_TOKENS.some((re) => re.test(text))) {
        found.push({ line: i + 1, text: text.trim() });
      }
    });
  return found;
}

function checkProviderCodeLivesInScm() {
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    if (!existsSync(join(ROOT, 'packages', pkg, 'src'))) {
      continue;
    }
    const files = walk(
      join('packages', pkg, 'src'),
      (f) => SOURCE_EXTENSION.test(f) && !/\.(?:test|spec)\./.test(f)
    ).filter((f) => !posixPath(f).includes('/generated/'));
    for (const file of files) {
      for (const v of providerCodeOutsideScmViolations(file, read(file))) {
        fail(
          file,
          v.line,
          'provider-code-lives-in-scm',
          `names another SCM provider's API outside lib/scm/: ${v.text.slice(0, 120)}`,
          'Provider network code must live in packages/worker/src/lib/scm/, where the bare-fetch, ' +
            'redirect and merge rules apply, and must call the SSRF guards (createGuardedFetch). ' +
            'A gateway or shared file must not carry its own GitLab, Bitbucket, Gitea, Azure ' +
            'DevOps or Gerrit client.'
        );
      }
    }
  }
}

function main() {
  checkWorkspaceImageLiterals();
  checkDockerfileYarnProvisioning();
  checkLayoutRendersPerRequest();
  checkMcpCodeHasNoDatabaseAccess();
  checkConnectorFetchesSetRedirect();
  checkOperatorUrlFetchesAreGuarded();
  checkOptInSuitesRunInCi();
  checkLiveSuitesRunInLiveWorkflow();
  checkComposeProfilesAreAdded();
  checkCredentialsAreNotInEnv();
  checkNoImmediateMerge();
  checkSlackMessageWriters();
  checkProviderCodeLivesInScm();
  report();
}

function report() {
  if (failures.length > 0) {
    console.error(`Invariant check failed — ${failures.length} violation(s).\n`);
    for (const f of failures) {
      console.error(`  ${relative('.', f.file)}:${f.line}  [${f.invariant}]`);
      console.error(`    ${f.detail}`);
      console.error(`    ${f.why}\n`);
    }
    console.error('These rules exist because each one already shipped to main past a green');
    console.error('test suite. If a violation is deliberate, say so in code and adjust the rule\n');
    console.error('in scripts/check-invariants.mjs — do not silence it at the call site.\n');
    process.exit(1);
  }

  console.log('Invariant check passed — 12 invariants, no violations.');
  console.log('  workspace image is inherited, never written inline at a call site');
  console.log('  every Dockerfile stage that runs yarn provides one first, and no other does');
  console.log('  the root layout renders per request when it reads NEXT_PUBLIC_* at runtime');
  console.log('  MCP code takes no database access: it reaches data only through a REST route');
  console.log('  connector and SCM-provider fetches state a redirect policy');
  console.log(
    '  fetches to operator-supplied URLs and SCM provider files resolve and pin their address'
  );
  console.log('  every database- or Docker-backed test suite runs in CI with its opt-in flag set');
  console.log(
    '  every live suite runs from live-e2e.yml, which starts only on a schedule or on demand'
  );
  console.log('  compose entry points add profiles to COMPOSE_PROFILES, never replace them');
  console.log('  credentials reach a workspace command through secretEnv, never an env list');
  console.log(
    '  no known immediate-merge spelling in source: auto-merge is the only merge path used'
  );
  console.log(
    '  Slack messages are sent only through known writers, and the worker defuses broadcasts'
  );
  console.log("  another SCM provider's API client lives in worker/src/lib/scm/, nowhere else");
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
