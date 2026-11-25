/**
 * The shell text of each campaign recipe (`@auto-swe/shared/lib/campaignRecipes` is the catalogue
 * and the parameter validation; this is what runs).
 *
 * A recipe runs through the `shell` step machinery: an allowlisted image, the repository cloned
 * into a volume that holds no credential, the run's egress policy, and a commit-and-push only when
 * the command exits 0. The script's exit code is its whole interface:
 *
 *   0  nothing to do (the repository does not use the package, or it is already at the version),
 *      or the change was made. The platform tells the two apart by whether files changed.
 *   3  the recipe cannot apply here (an unsupported lockfile or workspace layout, a vendored Go
 *      module or a go.work workspace, a dependency declared in a form the recipe does not
 *      rewrite). The agent takes over, if the campaign has one.
 *   4  the tool ran and did not end where the recipe asked.
 *   other non-zero: the tool failed (install error, no network). Same handling as 3.
 *
 * Injection boundary. Both parameters reach a shell, so each is validated by the shared schema
 * (here again, because the worker never trusts payload text), and then handed to the script ONLY
 * as the value of an environment variable, written with {@link shellQuote}. Neither is ever
 * spliced into a command word or into the text of the JavaScript or awk programs, which are
 * constants. A value that fails validation throws before any text is built.
 */
import {
  CAMPAIGN_RECIPES,
  type CampaignCheckResult,
  type CampaignRecipeParams,
  type CampaignRecipeRef,
  CHECK_EVIDENCE_PREFIX,
  parseCheckResult,
  parseRecipeParams,
  recipeSupportsCheck,
} from '@auto-swe/shared/lib/campaignRecipes';
import { shellQuote } from './shellQuote.js';

/** Exit code: the recipe cannot apply to this repository's layout. */
export const RECIPE_EXIT_UNSUPPORTED = 3;
/** Exit code: the tool ran but the repository did not end at the requested version. */
export const RECIPE_EXIT_NOT_RESOLVED = 4;

/** Exit code: the recipe's tool or decision program failed (not a verdict). */
export const RECIPE_EXIT_TOOL_FAILED = 5;

/** Reads package.json; prints `absent`, `workspaces`, `unsupported`, or `found <kind> <style>`. */
const NPM_CLASSIFY_JS = `
const fs = require('node:fs');
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const n = process.env.PKG;
const pick = (k) => (p[k] && Object.hasOwn(p[k], n) ? [k, String(p[k][n])] : null);
const hit = pick('dependencies') || pick('devDependencies') || pick('optionalDependencies');
if (!hit) { console.log(p.workspaces ? 'workspaces' : 'absent'); process.exit(0); }
const spec = hit[1];
if (!/^[\\^~]?\\d+(\\.\\d+){0,2}([-+][0-9A-Za-z.+-]*)?$/.test(spec)) { console.log('unsupported'); process.exit(0); }
const kind = { dependencies: 'prod', devDependencies: 'dev', optionalDependencies: 'optional' }[hit[0]];
const style = spec.startsWith('^') ? 'caret' : spec.startsWith('~') ? 'tilde' : 'exact';
console.log('found ' + kind + ' ' + style);
`.trim();

/** Prints the version package-lock.json resolves the package to, or nothing. */
const NPM_LOCKED_JS = `
const l = JSON.parse(require('node:fs').readFileSync('package-lock.json', 'utf8'));
const n = process.env.PKG;
const e = l.packages && l.packages['node_modules/' + n];
const v = e ? e.version : l.dependencies && l.dependencies[n] ? l.dependencies[n].version : '';
console.log(v || '');
`.trim();

/** Prints the version go.mod requires the module at, or nothing. A constant awk program. */
const GO_REQUIRED_AWK = `
$1 == "require" && $2 == "(" { r = 1; next }
r && $1 == ")" { r = 0; next }
$1 == "require" && $2 == ENVIRON["MOD"] { print $3; exit }
r && $1 == ENVIRON["MOD"] { print $2; exit }
`.trim();

function header(ref: string, params: CampaignRecipeParams): string {
  // JSON.stringify escapes newlines and control characters, so the comment cannot be ended early.
  // Padded past 80 characters because the platform's commit message carries the first 80.
  return `# ${`campaign recipe ${ref} ${JSON.stringify(params.packageName)} ${JSON.stringify(params.targetVersion)}`.padEnd(80)}`;
}

function npmScript(params: CampaignRecipeParams): string {
  return [
    header('npm-dependency@1', params),
    'set -eu',
    `export PKG=${shellQuote(params.packageName)} VER=${shellQuote(params.targetVersion)}`,
    'export NPM_CONFIG_IGNORE_SCRIPTS=true NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false NPM_CONFIG_UPDATE_NOTIFIER=false',
    'if [ ! -f package.json ]; then echo "not affected: no package.json at the repository root"; exit 0; fi',
    `STATE=$(node -e ${shellQuote(NPM_CLASSIFY_JS)})`,
    'case "$STATE" in',
    '  absent) echo "not affected: $PKG is not a dependency of the root package.json"; exit 0 ;;',
    `  workspaces) echo "cannot apply: $PKG is not in the root package.json of a workspaces repository" >&2; exit ${RECIPE_EXIT_UNSUPPORTED} ;;`,
    `  unsupported) echo "cannot apply: $PKG is declared as something other than a plain version range" >&2; exit ${RECIPE_EXIT_UNSUPPORTED} ;;`,
    '  "found "*) ;;',
    `  *) echo "cannot apply: package.json could not be classified" >&2; exit ${RECIPE_EXIT_UNSUPPORTED} ;;`,
    'esac',
    `if [ -f pnpm-lock.yaml ] || [ -f yarn.lock ] || [ -f bun.lock ] || [ -f bun.lockb ] || [ -f npm-shrinkwrap.json ]; then echo "cannot apply: unsupported lockfile (only package-lock.json is handled)" >&2; exit ${RECIPE_EXIT_UNSUPPORTED}; fi`,
    `if [ ! -f package-lock.json ]; then echo "cannot apply: no package-lock.json" >&2; exit ${RECIPE_EXIT_UNSUPPORTED}; fi`,
    `LOCKED=$(node -e ${shellQuote(NPM_LOCKED_JS)})`,
    'if [ "$LOCKED" = "$VER" ]; then echo "not affected: $PKG is already at $VER"; exit 0; fi',
    'case "$STATE" in',
    '  *" dev "*) KIND=--save-dev ;;',
    '  *" optional "*) KIND=--save-optional ;;',
    '  *) KIND=--save-prod ;;',
    'esac',
    'case "$STATE" in',
    '  *" exact") STYLE=--save-exact ;;',
    '  *" tilde") STYLE=\'--save-prefix=~\' ;;',
    "  *) STYLE='--save-prefix=^' ;;",
    'esac',
    'npm install --package-lock-only --ignore-scripts --no-audit --no-fund "$KIND" "$STYLE" -- "$PKG@$VER"',
    `LOCKED=$(node -e ${shellQuote(NPM_LOCKED_JS)})`,
    `if [ "$LOCKED" != "$VER" ]; then echo "the lockfile resolves $PKG to '$LOCKED', not $VER" >&2; exit ${RECIPE_EXIT_NOT_RESOLVED}; fi`,
    'echo "raised $PKG to $VER"',
  ].join('\n');
}

function goScript(params: CampaignRecipeParams): string {
  const required = `awk ${shellQuote(GO_REQUIRED_AWK)} go.mod`;
  return [
    header('go-module@1', params),
    'set -eu',
    `export MOD=${shellQuote(params.packageName)} VER=${shellQuote(params.targetVersion)}`,
    'if [ ! -f go.mod ]; then echo "not affected: no go.mod at the repository root"; exit 0; fi',
    `CUR=$(${required})`,
    'if [ -z "$CUR" ]; then echo "not affected: $MOD is not required by go.mod"; exit 0; fi',
    'if [ "$CUR" = "$VER" ]; then echo "not affected: $MOD is already at $VER"; exit 0; fi',
    // `go get` and `go mod tidy` leave a vendor directory stale (and `-mod=vendor` builds then
    // fail), and a go.work workspace decides the build list across modules the recipe does not
    // read. Neither is handled, so the agent takes over.
    `if [ -f vendor/modules.txt ]; then echo "cannot apply: the module vendors its dependencies (vendor/modules.txt), and the recipe does not run go mod vendor" >&2; exit ${RECIPE_EXIT_UNSUPPORTED}; fi`,
    `if [ -f go.work ]; then echo "cannot apply: a go.work workspace" >&2; exit ${RECIPE_EXIT_UNSUPPORTED}; fi`,
    'export GOTOOLCHAIN=local GOFLAGS=-mod=mod',
    'go get -- "$MOD@$VER"',
    'go mod tidy',
    `NOW=$(${required})`,
    `if [ "$NOW" != "$VER" ]; then echo "go.mod requires $MOD at '$NOW', not $VER" >&2; exit ${RECIPE_EXIT_NOT_RESOLVED}; fi`,
    'echo "raised $MOD to $VER"',
  ].join('\n');
}

// ── The @2 recipes: one decision, two entry points ──────────────────────────────────────────────
//
// `apply` and `check` of a `@2` ref both embed the same decision text, so they cannot disagree: a
// repository `apply` would change is exactly one `check` calls not satisfied. The decision is
// satisfied when the root manifest does not declare the package, or declares it at or above the
// target (exact semver precedence; a lower version, and a pre-release of the target, are below it).
// It is read-only: no tool runs, nothing is written, and there is no network.
//
// The decision leaves VERDICT (`satisfied`, `unsatisfied`, `cannot`), EVIDENCE, DETAIL, DECLARED,
// RESOLVED and a human MSG in the shell. A layout the recipe cannot handle (`cannot`) is never
// satisfied: apply exits 3 on it, and so does check, with the same reason.
//
// The check's exit codes: 0 satisfied, 1 not satisfied, 3 cannot check (an unsupported layout),
// 5 the decision program failed. Its last stdout line is the evidence line:
//   CAMPAIGN_CHECK evidence=<kind> detail=<token> declared=<version|-> resolved=<version|->
// Every value on it is a fixed token or a version the decision parsed as semver, never raw
// repository text, so a repository cannot forge it.

/** Semver precedence (https://semver.org §11), shared by the JavaScript decision. */
const SEMVER_JS = `
const SEMVER = /^v?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?(?:-([0-9A-Za-z.-]+))?(?:\\+[0-9A-Za-z.+-]*)?$/;
const parse = (s) => {
  const m = SEMVER.exec(s);
  if (!m) return null;
  const pre = m[4] ? m[4].split('.') : [];
  if (pre.some((x) => x === '')) return null;
  return { core: [BigInt(m[1]), BigInt(m[2] ?? 0), BigInt(m[3] ?? 0)], pre };
};
const numeric = (x) => /^\\d+$/.test(x);
const cmpId = (a, b) => {
  if (numeric(a) && numeric(b)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (numeric(a)) return -1;
  if (numeric(b)) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
const cmp = (a, b) => {
  for (let i = 0; i < 3; i++) { if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1; }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (i >= a.pre.length) return -1;
    if (i >= b.pre.length) return 1;
    const c = cmpId(a.pre[i], b.pre[i]);
    if (c) return c;
  }
  return 0;
};
`.trim();

/**
 * The npm decision. Prints one line of seven words:
 * `<verdict> <evidence> <detail> <declared> <resolved> <section> <style>`, `-` for an empty word.
 * Layout order matches the `@1` script: a package absent from the root is satisfied (or cannot be
 * judged in a workspaces repository), then an unplain range, then the lockfile, then the version.
 */
const NPM_DECIDE_JS = `
const fs = require('node:fs');
${SEMVER_JS}
const out = (...w) => { console.log(w.map((x) => x || '-').join(' ')); process.exit(0); };
const fmt = (v) => v.core.join('.') + (v.pre.length ? '-' + v.pre.join('.') : '');
try {
  if (!fs.existsSync('package.json')) out('satisfied', 'not-declared', 'no-root-manifest');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const n = process.env.PKG;
  const pick = (k) => (p[k] && Object.hasOwn(p[k], n) ? [k, String(p[k][n])] : null);
  const hit = pick('dependencies') || pick('devDependencies') || pick('optionalDependencies');
  if (!hit) {
    if (p.workspaces) out('cannot', 'cannot-check', 'workspaces');
    out('satisfied', 'not-declared', 'not-a-dependency');
  }
  const spec = hit[1];
  if (!/^[\\^~]?\\d+(\\.\\d+){0,2}([-+][0-9A-Za-z.+-]*)?$/.test(spec)) out('cannot', 'cannot-check', 'unsupported-spec');
  const section = { dependencies: 'prod', devDependencies: 'dev', optionalDependencies: 'optional' }[hit[0]];
  const style = spec.startsWith('^') ? 'caret' : spec.startsWith('~') ? 'tilde' : 'exact';
  for (const f of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'npm-shrinkwrap.json']) {
    if (fs.existsSync(f)) out('cannot', 'cannot-check', 'unsupported-lockfile');
  }
  if (!fs.existsSync('package-lock.json')) out('cannot', 'cannot-check', 'no-package-lock');
  const target = parse(process.env.VER);
  const declared = parse(spec.replace(/^[\\^~]/, ''));
  if (!target || !declared) out('cannot', 'cannot-check', 'unparseable-version');
  const l = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const e = l.packages && l.packages['node_modules/' + n];
  const lockedText = e ? e.version : l.dependencies && l.dependencies[n] ? l.dependencies[n].version : '';
  const d = fmt(declared);
  if (cmp(declared, target) < 0) out('unsatisfied', 'below-target', 'declared-below', d, '', section, style);
  if (!lockedText) out('unsatisfied', 'below-target', 'not-locked', d, '', section, style);
  const locked = parse(String(lockedText));
  if (!locked) out('cannot', 'cannot-check', 'unparseable-version');
  const r = fmt(locked);
  if (cmp(locked, target) < 0) out('unsatisfied', 'below-target', 'locked-below', d, r, section, style);
  out('satisfied', 'declared-at-target', 'at-or-above', d, r, section, style);
} catch (err) {
  out('cannot', 'cannot-check', 'unreadable-manifest');
}
`.trim();

/** Prints `ge`, `lt` or `invalid`: whether CUR_V is at or above TARGET_V by semver precedence. */
const GO_COMPARE_AWK = `
function num(s) { sub(/^0+/, "", s); return s == "" ? "0" : s }
function cmpnum(a, b) {
  a = num(a); b = num(b)
  if (length(a) != length(b)) return length(a) < length(b) ? -1 : 1
  return (a "") < (b "") ? -1 : (a "") > (b "") ? 1 : 0
}
function parse(s, o,   i, core) {
  if (s !~ /^v[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.+-]*)?$/) return 0
  sub(/\\+.*$/, "", s)
  sub(/^v/, "", s)
  o["pre"] = ""
  i = index(s, "-")
  if (i) { o["pre"] = substr(s, i + 1); s = substr(s, 1, i - 1) }
  if (o["pre"] ~ /(^\\.|\\.\\.|\\.$)/) return 0
  split(s, core, ".")
  o[1] = core[1]; o[2] = core[2]; o[3] = core[3]
  return 1
}
function cmpid(a, b) {
  if (a ~ /^[0-9]+$/ && b ~ /^[0-9]+$/) return cmpnum(a, b)
  if (a ~ /^[0-9]+$/) return -1
  if (b ~ /^[0-9]+$/) return 1
  return (a "") < (b "") ? -1 : (a "") > (b "") ? 1 : 0
}
BEGIN {
  if (!parse(ENVIRON["CUR_V"], a) || !parse(ENVIRON["TARGET_V"], b)) { print "invalid"; exit }
  c = 0
  for (i = 1; i <= 3 && c == 0; i++) c = cmpnum(a[i], b[i])
  if (c == 0) {
    if (a["pre"] == "" && b["pre"] == "") c = 0
    else if (a["pre"] == "") c = 1
    else if (b["pre"] == "") c = -1
    else {
      n = split(a["pre"], pa, "."); m = split(b["pre"], pb, ".")
      for (i = 1; i <= n && i <= m && c == 0; i++) c = cmpid(pa[i], pb[i])
      if (c == 0) c = n < m ? -1 : n > m ? 1 : 0
    }
  }
  print (c >= 0 ? "ge" : "lt")
}
`.trim();

/** Human text per decision detail; both entry points print the same sentence. */
const NPM_MESSAGES: Record<string, string> = {
  'at-or-above': '$PKG is declared and locked at or above $VER',
  'declared-below': '$PKG is declared below $VER',
  'locked-below': '$PKG is locked below $VER',
  'no-package-lock': 'no package-lock.json',
  'no-root-manifest': 'no package.json at the repository root',
  'not-a-dependency': '$PKG is not a dependency of the root package.json',
  'not-locked': '$PKG is declared at or above $VER but package-lock.json does not resolve it',
  'unparseable-version': 'a version is not valid semver',
  'unreadable-manifest': 'package.json or package-lock.json could not be read',
  'unsupported-lockfile': 'unsupported lockfile (only package-lock.json is handled)',
  'unsupported-spec': '$PKG is declared as something other than a plain version range',
  workspaces: '$PKG is not in the root package.json of a workspaces repository',
};

function npmDecision(): string[] {
  return [
    `OUT=$(node -e ${shellQuote(NPM_DECIDE_JS)}) || { echo "cannot check: the decision program failed" >&2; exit ${RECIPE_EXIT_TOOL_FAILED}; }`,
    'set -f',
    'set -- $OUT',
    'set +f',
    `if [ "$#" -lt 3 ]; then echo "cannot check: the decision program printed nothing usable" >&2; exit ${RECIPE_EXIT_TOOL_FAILED}; fi`,
    'set -- "$@" - - - -',
    'VERDICT=$1 EVIDENCE=$2 DETAIL=$3 DECLARED=$4 RESOLVED=$5 SECTION=$6 STYLE_=$7',
    'case "$DETAIL" in',
    ...Object.entries(NPM_MESSAGES).map(([k, v]) => `  ${k}) MSG="${v}" ;;`),
    '  *) MSG="$DETAIL" ;;',
    'esac',
  ];
}

const GO_MESSAGES = {
  'at-or-above': '$MOD is required at or above $VER',
  'below-target': '$MOD is required below $VER',
  'go-work': 'a go.work workspace',
  'no-root-manifest': 'no go.mod at the repository root',
  'not-required': '$MOD is not required by go.mod',
  'unparseable-version': 'a version is not valid semver',
  vendored:
    'the module vendors its dependencies (vendor/modules.txt), and the recipe does not run go mod vendor',
} as const;

function goDecision(): string[] {
  const set = (
    verdict: string,
    evidence: string,
    detail: keyof typeof GO_MESSAGES,
    declared = '-'
  ) =>
    `VERDICT=${verdict} EVIDENCE=${evidence} DETAIL=${detail} DECLARED=${declared} RESOLVED=- MSG="${GO_MESSAGES[detail]}"`;
  const fail = `|| { echo "cannot check: the decision program failed" >&2; exit ${RECIPE_EXIT_TOOL_FAILED}; }`;
  return [
    'VERDICT= EVIDENCE= DETAIL= DECLARED=- RESOLVED=- MSG=',
    'if [ ! -f go.mod ]; then',
    `  ${set('satisfied', 'not-declared', 'no-root-manifest')}`,
    'else',
    `  CUR=$(LC_ALL=C awk ${shellQuote(GO_REQUIRED_AWK)} go.mod) ${fail}`,
    '  if [ -z "$CUR" ]; then',
    `    ${set('satisfied', 'not-declared', 'not-required')}`,
    '  else',
    `    CMP=$(LC_ALL=C CUR_V="$CUR" TARGET_V="$VER" awk ${shellQuote(GO_COMPARE_AWK)}) ${fail}`,
    '    if [ "$CMP" = ge ]; then',
    `      ${set('satisfied', 'declared-at-target', 'at-or-above', '$CUR')}`,
    '    elif [ "$CMP" != lt ]; then',
    `      ${set('cannot', 'cannot-check', 'unparseable-version')}`,
    // `go get` and `go mod tidy` leave a vendor directory stale, and a go.work workspace decides
    // the build list across modules the recipe does not read: neither is handled.
    '    elif [ -f vendor/modules.txt ]; then',
    `      ${set('cannot', 'cannot-check', 'vendored')}`,
    '    elif [ -f go.work ]; then',
    `      ${set('cannot', 'cannot-check', 'go-work')}`,
    '    else',
    `      ${set('unsatisfied', 'below-target', 'below-target', '$CUR')}`,
    '    fi',
    '  fi',
    'fi',
  ];
}

/** The decision text of a `@2` ref, identical in its apply and its check script. */
function decisionLines(ref: CampaignRecipeRef): string[] {
  return CAMPAIGN_RECIPES[ref].ecosystem === 'npm' ? npmDecision() : goDecision();
}

function npmApply2(params: CampaignRecipeParams): string {
  return [
    header('npm-dependency@2', params),
    'set -eu',
    `export PKG=${shellQuote(params.packageName)} VER=${shellQuote(params.targetVersion)}`,
    'export NPM_CONFIG_IGNORE_SCRIPTS=true NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false NPM_CONFIG_UPDATE_NOTIFIER=false',
    ...decisionLines('npm-dependency@2'),
    'case "$VERDICT" in',
    '  satisfied) echo "not affected: $MSG"; exit 0 ;;',
    `  cannot) echo "cannot apply: $MSG" >&2; exit ${RECIPE_EXIT_UNSUPPORTED} ;;`,
    'esac',
    'case "$SECTION" in',
    '  dev) KIND=--save-dev ;;',
    '  optional) KIND=--save-optional ;;',
    '  *) KIND=--save-prod ;;',
    'esac',
    'case "$STYLE_" in',
    '  exact) STYLE=--save-exact ;;',
    "  tilde) STYLE='--save-prefix=~' ;;",
    "  *) STYLE='--save-prefix=^' ;;",
    'esac',
    'npm install --package-lock-only --ignore-scripts --no-audit --no-fund "$KIND" "$STYLE" -- "$PKG@$VER"',
    `LOCKED=$(node -e ${shellQuote(NPM_LOCKED_JS)})`,
    `if [ "$LOCKED" != "$VER" ]; then echo "the lockfile resolves $PKG to '$LOCKED', not $VER" >&2; exit ${RECIPE_EXIT_NOT_RESOLVED}; fi`,
    'echo "raised $PKG to $VER"',
  ].join('\n');
}

function goApply2(params: CampaignRecipeParams): string {
  const required = `awk ${shellQuote(GO_REQUIRED_AWK)} go.mod`;
  return [
    header('go-module@2', params),
    'set -eu',
    `export MOD=${shellQuote(params.packageName)} VER=${shellQuote(params.targetVersion)}`,
    ...decisionLines('go-module@2'),
    'case "$VERDICT" in',
    '  satisfied) echo "not affected: $MSG"; exit 0 ;;',
    `  cannot) echo "cannot apply: $MSG" >&2; exit ${RECIPE_EXIT_UNSUPPORTED} ;;`,
    'esac',
    'export GOTOOLCHAIN=local GOFLAGS=-mod=mod',
    'go get -- "$MOD@$VER"',
    'go mod tidy',
    `NOW=$(${required})`,
    `if [ "$NOW" != "$VER" ]; then echo "go.mod requires $MOD at '$NOW', not $VER" >&2; exit ${RECIPE_EXIT_NOT_RESOLVED}; fi`,
    'echo "raised $MOD to $VER"',
  ].join('\n');
}

function checkTail(): string[] {
  return [
    'case "$VERDICT" in',
    '  cannot) echo "cannot check: $MSG" >&2 ;;',
    '  *) echo "$MSG" ;;',
    'esac',
    `echo "${CHECK_EVIDENCE_PREFIX} evidence=$EVIDENCE detail=$DETAIL declared=$DECLARED resolved=$RESOLVED"`,
    'case "$VERDICT" in',
    '  satisfied) exit 0 ;;',
    '  unsatisfied) exit 1 ;;',
    `  *) exit ${RECIPE_EXIT_UNSUPPORTED} ;;`,
    'esac',
  ];
}

function checkHeader(ref: string, params: CampaignRecipeParams): string {
  return header(`check ${ref}`, params);
}

function npmCheck2(params: CampaignRecipeParams): string {
  return [
    checkHeader('npm-dependency@2', params),
    'set -eu',
    `export PKG=${shellQuote(params.packageName)} VER=${shellQuote(params.targetVersion)}`,
    ...decisionLines('npm-dependency@2'),
    ...checkTail(),
  ].join('\n');
}

function goCheck2(params: CampaignRecipeParams): string {
  return [
    checkHeader('go-module@2', params),
    'set -eu',
    `export MOD=${shellQuote(params.packageName)} VER=${shellQuote(params.targetVersion)}`,
    ...decisionLines('go-module@2'),
    ...checkTail(),
  ].join('\n');
}

const SCRIPTS: Record<CampaignRecipeRef, (params: CampaignRecipeParams) => string> = {
  'go-module@1': goScript,
  'go-module@2': goApply2,
  'npm-dependency@1': npmScript,
  'npm-dependency@2': npmApply2,
};

const CHECK_SCRIPTS: Partial<Record<CampaignRecipeRef, (params: CampaignRecipeParams) => string>> =
  {
    'go-module@2': goCheck2,
    'npm-dependency@2': npmCheck2,
  };

/**
 * The command for one recipe. Throws on an unknown recipe or invalid parameters; the caller turns
 * that into a failed (not thrown) recipe so the agent can still take over.
 */
export function buildRecipeCommand(ref: string, params: unknown): string {
  const parsed = parseRecipeParams(ref, params);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return SCRIPTS[parsed.ref](parsed.params);
}

/**
 * The read-only check script of a recipe: no install, no commit, no push, no network. Exit 0 means
 * satisfied, 1 not satisfied, anything else could not run (3 an unsupported layout, 5 a failed
 * decision program); the last stdout line is the evidence line (`parseCheckResult` reads it).
 * Throws for a ref with no check (a `@1` ref), an unknown ref or invalid parameters.
 */
export function buildRecipeCheckCommand(ref: string, params: unknown): string {
  const parsed = parseRecipeParams(ref, params);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const build = recipeSupportsCheck(parsed.ref) ? CHECK_SCRIPTS[parsed.ref] : undefined;
  if (!build) {
    throw new Error(`recipe ${parsed.ref} has no check`);
  }
  return build(parsed.params);
}

/** Interpret what the sandbox returned for a check script. Pure. */
export function interpretRecipeCheck(out: {
  exitCode: number | null;
  stdout: string;
}): CampaignCheckResult {
  return parseCheckResult(out);
}

/** The image and wall-clock bound of a recipe, from the catalogue. */
export function recipeRuntime(ref: CampaignRecipeRef): { image: string; timeoutMs: number } {
  const { image, timeoutMs } = CAMPAIGN_RECIPES[ref];
  return { image, timeoutMs };
}
