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

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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
            "operator's configured image is never read. Pass `repo.executorImage ?? undefined`, " +
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
/** Each pattern is a way to reach the database; comments are stripped before matching. */
const DATABASE_ACCESS = [
  [/from\s+['"][^'"]*@auto-swe\/shared\/db(?:\.js)?['"]/, 'imports @auto-swe/shared/db'],
  [/from\s+['"][^'"]*\/plugins\/prisma(?:\.js)?['"]/, 'imports the prisma plugin'],
  [/from\s+['"]@prisma\//, 'imports @prisma/*'],
  [/from\s+['"][^'"]*generated\/prisma/, 'imports the generated Prisma client'],
  [/\bPrismaClient\b/, 'names PrismaClient'],
  [/\.prisma\b/, 'reads the `prisma` decoration (app.prisma / request.server.prisma)'],
  [/\bprisma\s*\.\s*[$\w]/, 'calls a `prisma` client'],
  [/\$queryRaw|\$executeRaw/, 'runs raw SQL'],
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

function checkMcpCodeHasNoDatabaseAccess() {
  const files = [
    ...walk(MCP_CODE_DIR, (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
    MCP_ROUTE_FILE,
  ];
  for (const file of files) {
    const lines = stripComments(read(file)).split('\n');
    lines.forEach((text, i) => {
      for (const [pattern, what] of DATABASE_ACCESS) {
        if (pattern.test(text)) {
          fail(
            file,
            i + 1,
            'mcp-no-database-access',
            `MCP code ${what}`,
            "MCP tools must reach data only through a REST route, by the bridge, so the route's " +
              'role check, visibility filter, tenant guard and audit apply to them. Direct access is a ' +
              'second, weaker permission path. Move the database work to a route, or hand this code a ' +
              'plain function from the wiring in lib/mcpRouteOptions.ts.'
          );
        }
      }
    });
  }
}

// ---------------------------------------------------------------------------

checkWorkspaceImageLiterals();
checkDockerfileYarnProvisioning();
checkLayoutRendersPerRequest();
checkMcpCodeHasNoDatabaseAccess();

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

console.log('Invariant check passed — 4 invariants, no violations.');
console.log('  workspace image is inherited, never written inline at a call site');
console.log('  every Dockerfile stage that runs yarn provides one first, and no other does');
console.log('  the root layout renders per request when it reads NEXT_PUBLIC_* at runtime');
console.log('  MCP code takes no database access: it reaches data only through a REST route');
