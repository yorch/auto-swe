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
 *   3  the recipe cannot apply here (an unsupported lockfile or workspace layout, a dependency
 *      declared in a form the recipe does not rewrite). The agent takes over, if the campaign has one.
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
  type CampaignRecipeParams,
  type CampaignRecipeRef,
  parseRecipeParams,
} from '@auto-swe/shared/lib/campaignRecipes';
import { shellQuote } from './shellQuote.js';

/** Exit code: the recipe cannot apply to this repository's layout. */
export const RECIPE_EXIT_UNSUPPORTED = 3;
/** Exit code: the tool ran but the repository did not end at the requested version. */
export const RECIPE_EXIT_NOT_RESOLVED = 4;

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
    'export GOTOOLCHAIN=local GOFLAGS=-mod=mod',
    'go get -- "$MOD@$VER"',
    'go mod tidy',
    `NOW=$(${required})`,
    `if [ "$NOW" != "$VER" ]; then echo "go.mod requires $MOD at '$NOW', not $VER" >&2; exit ${RECIPE_EXIT_NOT_RESOLVED}; fi`,
    'echo "raised $MOD to $VER"',
  ].join('\n');
}

const SCRIPTS: Record<CampaignRecipeRef, (params: CampaignRecipeParams) => string> = {
  'go-module@1': goScript,
  'npm-dependency@1': npmScript,
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

/** The image and wall-clock bound of a recipe, from the catalogue. */
export function recipeRuntime(ref: CampaignRecipeRef): { image: string; timeoutMs: number } {
  const { image, timeoutMs } = CAMPAIGN_RECIPES[ref];
  return { image, timeoutMs };
}
