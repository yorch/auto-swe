#!/usr/bin/env node
/**
 * Create or update a `.env` from `.env.example`.
 *
 *   node scripts/env-setup.mjs <init|sync|check> [options]
 *   yarn env:setup <init|sync|check> [options]
 *
 * Zero dependencies (Node built-ins only) so it runs before `yarn install`.
 * `.env.example` is the source of truth for layout, comments and defaults; this
 * file holds only what a template cannot say — which keys are secrets, how each
 * is generated, and how each is validated (`SECRETS`).
 *
 * Hard rules: a secret that already has a value is never regenerated (rotating
 * CONFIG_ENCRYPTION_KEY orphans every encrypted DB row — that is
 * `yarn keys:rotate`'s job), secret values are never printed, and files are
 * written 0600.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LOCAL_ADDITIONS_HEADER = '# ── Local additions (not in .env.example) ──';

/** Old key -> new key. A value set under the old name moves to the new one on `sync`. */
export const RENAMED_KEYS = {};

/** Keys whose value is a URL a browser or external client reaches. */
export const PUBLIC_URL_KEYS = [
  'BETTER_AUTH_URL',
  'CORS_ORIGIN',
  'NEXT_PUBLIC_API_URL',
  'PUBLIC_URL',
  'WEB_URL',
];

export const DEV_DEFAULTS = {
  ARTIFACT_S3_ACCESS_KEY: 'autoswelocal',
  ARTIFACT_S3_SECRET_KEY: 'autoswelocaldevsecret',
  POSTGRES_PASSWORD: 'password',
};

const SECRET_NAME_RE = /SECRET|TOKEN|PASSWORD|KEY$|PRIVATE/;

// ---------------------------------------------------------------------------
// Secret table
// ---------------------------------------------------------------------------

const b64 = (n) => (rand) => rand(n).toString('base64');
const hex = (n) => (rand) => rand(n).toString('hex');

const objectstoreActive = (env) => profilesOf(env.get('COMPOSE_PROFILES')).includes('objectstore');

const authSecretError = (name) => (v) =>
  v.length < 32 ? `${name} must be at least 32 characters (found ${v.length})` : null;

/**
 * `required` — an empty value is a `check` failure and `init`/`sync` generate it.
 * `when(env)` — narrows `required` to a condition over the effective env.
 * `generate(rand)` — a fresh value. `validate(value)` — an error string, or null.
 */
export const SECRETS = {
  ARTIFACT_S3_ACCESS_KEY: {
    // Garage key ids are `GK` + 24 hex; hosted providers accept any string.
    generate: (rand) => `GK${rand(12).toString('hex')}`,
    required: false,
    validate: (v) =>
      v.length < 16 ? 'ARTIFACT_S3_ACCESS_KEY must be at least 16 characters' : null,
  },
  ARTIFACT_S3_SECRET_KEY: {
    generate: hex(32),
    required: false,
    validate: (v) =>
      v.length < 16 ? 'ARTIFACT_S3_SECRET_KEY must be at least 16 characters' : null,
  },
  BETTER_AUTH_SECRET: {
    generate: b64(48),
    required: true,
    validate: authSecretError('BETTER_AUTH_SECRET'),
  },
  CONFIG_ENCRYPTION_KEY: {
    generate: b64(32),
    required: true,
    validate: (v) => {
      const bytes = Buffer.from(v, 'base64');
      return bytes.length === 32 && bytes.toString('base64') === v
        ? null
        : 'CONFIG_ENCRYPTION_KEY must be base64 of exactly 32 bytes';
    },
  },
  GARAGE_RPC_SECRET: {
    generate: hex(32),
    required: true,
    validate: (v) =>
      /^[0-9a-fA-F]{64}$/.test(v) ? null : 'GARAGE_RPC_SECRET must be 64 hex characters',
    when: objectstoreActive,
  },
  JWT_SECRET: {
    generate: b64(48),
    required: true,
    validate: authSecretError('JWT_SECRET'),
    // An RS256 key pair replaces the HS256 secret.
    when: (env) => !(env.get('JWT_PRIVATE_KEY_PATH') && env.get('JWT_PUBLIC_KEY_PATH')),
  },
  SEED_ADMIN_PASSWORD: {
    generate: b64(24),
    required: true,
    validate: (v) => (v.length < 8 ? 'SEED_ADMIN_PASSWORD must be at least 8 characters' : null),
  },
};

const isRequired = (spec, env) => spec.required && (spec.when ? spec.when(env) : true);

export function profilesOf(value) {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Parsing (Node `--env-file` / dotenv semantics)
// ---------------------------------------------------------------------------

const ACTIVE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;
const COMMENTED_RE = /^#\s?([A-Z][A-Z0-9_]*)=(.*)$/;

/** Value of an assignment's right-hand side, plus how many lines it spans. */
function readValue(lines, start, rest) {
  const lead = rest.trimStart();
  const quote = lead[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    let body = lead.slice(1);
    let end = start;
    let close = body.indexOf(quote);
    while (close === -1 && end + 1 < lines.length) {
      end += 1;
      body += `\n${lines[end]}`;
      close = body.indexOf(quote);
    }
    if (close !== -1) {
      const inner = body.slice(0, close);
      return { end, value: quote === '"' ? inner.replace(/\\n/g, '\n') : inner };
    }
    // Unterminated: dotenv treats the rest as a plain unquoted value.
  }
  const hash = rest.indexOf('#');
  return { end: start, value: (hash === -1 ? rest : rest.slice(0, hash)).trim() };
}

/**
 * Parse env text into ordered items:
 *   { type: 'kv', key, value, valueRaw, text }       an active assignment (may span lines)
 *   { type: 'commented', key, valueRaw, text }       `# KEY=value` in a template
 *   { type: 'text', text }                           anything else, verbatim
 */
export function parseEnv(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const active = line.trimStart().startsWith('#') ? null : ACTIVE_RE.exec(line);
    if (active) {
      const { end, value } = readValue(lines, i, active[2]);
      const chunk = lines.slice(i, end + 1);
      const eq = chunk[0].indexOf('=');
      chunk[0] = chunk[0].slice(eq + 1);
      items.push({
        key: active[1],
        text: lines.slice(i, end + 1).join('\n'),
        type: 'kv',
        value,
        valueRaw: chunk.join('\n'),
      });
      i = end;
      continue;
    }
    const commented = COMMENTED_RE.exec(line);
    if (commented) {
      items.push({ key: commented[1], text: line, type: 'commented', valueRaw: commented[2] });
    } else {
      items.push({ text: line, type: 'text' });
    }
  }
  return items;
}

/** Effective `KEY -> value` of the active assignments (last one wins, as in Node). */
export function parseValues(text) {
  const map = new Map();
  for (const item of parseEnv(text)) {
    if (item.type === 'kv') {
      map.set(item.key, item.value);
    }
  }
  return map;
}

/** Spell a value so both Node `--env-file` and Docker Compose read it back unchanged. */
export function formatValue(value) {
  if (/^[^\s#'"`\\$]*$/.test(value)) {
    return value;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!/[$"\\]/.test(value)) {
    return `"${value}"`;
  }
  throw new Error('value cannot be written to an env file (mixes quote characters and $ or \\)');
}

// ---------------------------------------------------------------------------
// Planning: which values to set that the user's file does not already carry
// ---------------------------------------------------------------------------

const urlsFromDomains = (env) => {
  const out = new Map();
  const api = env.get('DOMAIN_API');
  const app = env.get('DOMAIN_APP');
  if (api) {
    for (const k of ['PUBLIC_URL', 'BETTER_AUTH_URL', 'NEXT_PUBLIC_API_URL']) {
      out.set(k, `https://${api}`);
    }
  }
  if (app) {
    for (const k of ['CORS_ORIGIN', 'WEB_URL']) {
      out.set(k, `https://${app}`);
    }
  }
  return out;
};

export function databaseUrl(user, password, db, previous) {
  let hostPart = 'localhost:5432';
  let search = '';
  try {
    const u = new URL(previous);
    if (u.host) {
      hostPart = u.host;
    }
    search = u.search;
  } catch {}
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${hostPart}/${encodeURIComponent(db)}${search}`;
}

/**
 * Compute the values to write on top of what the file already has.
 *
 * @param {Map<string,string>} base   effective values: template defaults overlaid by the file
 * @param {object} opts
 * @param {'init'|'sync'} opts.mode
 * @param {'local'|'prod'} opts.profile
 * @param {Map<string,string>} opts.sets   explicit values (`--set`, prompts); they always win
 * @param {(n:number)=>Buffer} opts.rand
 * @returns {{overrides: Map<string,string>, generated: string[]}}
 */
export function planValues(base, { mode, profile, rand, sets }) {
  const overrides = new Map(sets);
  const generated = [];
  const env = () => new Map([...base, ...overrides]);

  if (mode === 'init' && profile === 'prod') {
    const derived = urlsFromDomains(env());
    for (const [k, v] of derived) {
      if (!overrides.has(k)) {
        overrides.set(k, v);
      }
    }
    if (!overrides.has('NODE_ENV')) {
      overrides.set('NODE_ENV', 'production');
    }
    if (!overrides.has('POSTGRES_PASSWORD')) {
      // URL-safe, because it is embedded in DATABASE_URL.
      overrides.set('POSTGRES_PASSWORD', rand(24).toString('base64url'));
      generated.push('POSTGRES_PASSWORD');
    }
    if (objectstoreActive(env())) {
      for (const k of ['ARTIFACT_S3_ACCESS_KEY', 'ARTIFACT_S3_SECRET_KEY']) {
        if (!overrides.has(k)) {
          overrides.set(k, SECRETS[k].generate(rand));
          generated.push(k);
        }
      }
      if (!overrides.has('ARTIFACT_S3_BUCKET')) {
        overrides.set('ARTIFACT_S3_BUCKET', 'auto-swe-artifacts');
      }
    }
  } else if (mode === 'sync') {
    const derived = urlsFromDomains(new Map([...overrides]));
    for (const [k, v] of derived) {
      if (!overrides.has(k)) {
        overrides.set(k, v);
      }
    }
  }

  // Required secrets: generate only into a slot that is empty. Never replace a value.
  for (const [key, spec] of Object.entries(SECRETS)) {
    const current = overrides.has(key) ? overrides.get(key) : base.get(key);
    if (!current && isRequired(spec, env())) {
      overrides.set(key, spec.generate(rand));
      generated.push(key);
    }
  }

  const pg = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'];
  if (pg.some((k) => overrides.has(k)) && !overrides.has('DATABASE_URL')) {
    const e = env();
    overrides.set(
      'DATABASE_URL',
      databaseUrl(
        e.get('POSTGRES_USER') ?? 'postgres',
        e.get('POSTGRES_PASSWORD') ?? '',
        e.get('POSTGRES_DB') ?? 'engineering_system',
        e.get('DATABASE_URL') ?? ''
      )
    );
  }
  return { generated, overrides };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Re-render the template with the user's values carried over.
 *
 * Output follows the template's order and comments. A template key that is
 * commented becomes active, at its first occurrence, when it has a value; later
 * occurrences stay commented. Keys the template does not know go to a trailing
 * "Local additions" section, verbatim.
 */
export function renderEnv(template, existing, overrides = new Map(), renamed = RENAMED_KEYS) {
  const tItems = parseEnv(template);
  const user = new Map();
  for (const item of parseEnv(existing ?? '')) {
    if (item.type === 'kv') {
      user.set(item.key, item);
    }
  }

  const report = { added: [], carried: 0, localAdditions: [], renamed: [] };
  for (const [oldKey, newKey] of Object.entries(renamed)) {
    const old = user.get(oldKey);
    if (!old) {
      continue;
    }
    if (!user.has(newKey)) {
      user.set(newKey, { ...old, key: newKey });
      report.renamed.push(`${oldKey} -> ${newKey}`);
    }
    user.delete(oldKey);
  }

  const templateKeys = new Set(tItems.filter((i) => i.key).map((i) => i.key));
  const raw = (key) =>
    overrides.has(key) ? formatValue(overrides.get(key)) : user.get(key)?.valueRaw;
  const known = (key) => overrides.has(key) || user.has(key);

  const out = [];
  const emitted = new Set();
  for (const item of tItems) {
    if (item.type === 'text') {
      out.push(item.text);
    } else if (emitted.has(item.key)) {
      out.push(item.text);
    } else if (item.type === 'kv' && !known(item.key)) {
      out.push(item.text);
      emitted.add(item.key);
      if (existing) {
        report.added.push(item.key);
      }
    } else if (item.type === 'commented' && !known(item.key)) {
      out.push(item.text);
    } else {
      out.push(`${item.key}=${raw(item.key)}`);
      emitted.add(item.key);
      if (!user.has(item.key) && existing) {
        report.added.push(item.key);
      }
    }
  }

  for (const key of user.keys()) {
    if (templateKeys.has(key)) {
      report.carried += 1;
    }
  }

  const additions = new Map();
  for (const [key, item] of user) {
    if (!templateKeys.has(key)) {
      additions.set(key, item.text);
    }
  }
  for (const [key, value] of overrides) {
    if (!templateKeys.has(key)) {
      additions.set(key, `${key}=${formatValue(value)}`);
    }
  }
  if (additions.size > 0) {
    while (out.length > 0 && out[out.length - 1] === '') {
      out.pop();
    }
    out.push('', LOCAL_ADDITIONS_HEADER);
    for (const [key, text] of additions) {
      out.push(text);
      report.localAdditions.push(key);
    }
  }
  return { report, text: `${out.join('\n').replace(/\n+$/, '')}\n` };
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

const LOCAL_HOST_RE = /(^|\/\/|@)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i;

/** @returns {{errors: string[], warnings: string[]}} */
export function checkEnv(values, { profile = 'local', templateKeys = [] } = {}) {
  const errors = [];
  const warnings = [];
  const get = (k) => values.get(k) ?? '';

  for (const [key, spec] of Object.entries(SECRETS)) {
    const v = get(key);
    if (!v) {
      if (isRequired(spec, values)) {
        errors.push(
          key === 'GARAGE_RPC_SECRET'
            ? 'GARAGE_RPC_SECRET is empty but COMPOSE_PROFILES includes objectstore'
            : `${key} is required and empty`
        );
      }
      continue;
    }
    const problem = spec.validate(v);
    if (problem) {
      errors.push(problem);
    }
  }

  const {
    POSTGRES_USER: user,
    POSTGRES_PASSWORD: pw,
    POSTGRES_DB: db,
  } = Object.fromEntries(
    ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'].map((k) => [k, get(k)])
  );
  const dsn = get('DATABASE_URL');
  if (!dsn) {
    errors.push('DATABASE_URL is empty');
  } else if (user && pw && db) {
    try {
      const u = new URL(dsn);
      const same =
        decodeURIComponent(u.username) === user &&
        decodeURIComponent(u.password) === pw &&
        decodeURIComponent(u.pathname.slice(1)) === db;
      if (!same) {
        errors.push('DATABASE_URL does not match POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB');
      }
    } catch {
      errors.push('DATABASE_URL is not a valid URL');
    }
  }

  if (profile === 'prod') {
    for (const key of PUBLIC_URL_KEYS) {
      const v = get(key);
      if (!v) {
        errors.push(`${key} is unset (compose defaults it to localhost)`);
      } else if (LOCAL_HOST_RE.test(v)) {
        errors.push(`${key} points at localhost`);
      }
    }
    for (const key of ['DOMAIN_API', 'DOMAIN_APP']) {
      if (LOCAL_HOST_RE.test(get(key))) {
        errors.push(`${key} points at localhost`);
      }
    }
    for (const [key, dev] of Object.entries(DEV_DEFAULTS)) {
      if (get(key) === dev) {
        errors.push(`${key} is still the dev default`);
      }
    }
    for (const key of ['ARTIFACT_S3_ACCESS_KEY', 'ARTIFACT_S3_SECRET_KEY']) {
      if (!get(key)) {
        errors.push(`${key} is required by docker-compose.prod.yml`);
      }
    }
  }

  for (const key of templateKeys) {
    if (!values.has(key)) {
      warnings.push(`${key} is in the template but not in the file`);
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Masked diff (for --dry-run)
// ---------------------------------------------------------------------------

const hasPassword = (v) => /:\/\/[^/@\s]*:[^@\s]+@/.test(v);

/** The text with the value of every secret-ish key replaced by `****`. */
export function maskEnv(text) {
  return parseEnv(text)
    .map((item) => {
      if (item.type !== 'kv') {
        return item.text;
      }
      const secret =
        item.key in SECRETS || SECRET_NAME_RE.test(item.key) || hasPassword(item.value);
      return secret && item.value !== '' ? `${item.key}=****` : item.text;
    })
    .join('\n');
}

/** Minimal unified-style line diff with `context` lines around each change. */
export function unifiedDiff(a, b, context = 2) {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Int32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i -= 1) {
    for (let j = y.length - 1; j >= 0; j -= 1) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      ops.push([' ', x[i]]);
      i += 1;
      j += 1;
    } else if (i < x.length && (j === y.length || dp[i + 1][j] >= dp[i][j + 1])) {
      ops.push(['-', x[i]]);
      i += 1;
    } else {
      ops.push(['+', y[j]]);
      j += 1;
    }
  }
  const keep = new Array(ops.length).fill(false);
  ops.forEach(([tag], idx) => {
    if (tag === ' ') {
      return;
    }
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k += 1) {
      keep[k] = true;
    }
  });
  const out = [];
  let gap = false;
  ops.forEach(([tag, line], idx) => {
    if (!keep[idx]) {
      gap = true;
      return;
    }
    if (gap && out.length > 0) {
      out.push('@@');
    }
    gap = false;
    out.push(`${tag}${line}`);
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: env-setup <init|sync|check> [options]

  init    create .env from .env.example, generating the required secrets
  sync    re-render .env from the current template, keeping every value you set
  check   validate .env (read-only; exits 1 on a failure)

Options:
  --file <path>        target file (default .env)
  --template <path>    template (default .env.example)
  --profile local|prod default local; prod also generates a strong POSTGRES_PASSWORD
                       and S3 keys on init, and fails check on localhost / dev defaults
  --set KEY=VALUE      set a value (repeatable); always wins over prompts and defaults
  --dry-run            print a masked diff instead of writing
  --yes                never prompt (also the behaviour without a TTY)
`;

const timestamp = (now) => now.toISOString().replace(/[:.]/g, '-');

function parseSets(list) {
  const sets = new Map();
  for (const entry of list) {
    const eq = entry.indexOf('=');
    if (eq < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.slice(0, eq))) {
      throw new Error(`--set expects KEY=VALUE, got "${entry.split('=')[0]}"`);
    }
    sets.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  return sets;
}

async function promptAnswers({ profile, ask, defaults }) {
  const answers = new Map();
  const questions =
    profile === 'prod'
      ? [
          ['SEED_ADMIN_EMAIL', 'Admin email', defaults.get('SEED_ADMIN_EMAIL') ?? ''],
          ['DOMAIN_API', 'API domain (e.g. api.example.com; Enter to skip)', ''],
          ['DOMAIN_APP', 'Web app domain (e.g. app.example.com; Enter to skip)', ''],
        ]
      : [['SEED_ADMIN_EMAIL', 'Admin email', defaults.get('SEED_ADMIN_EMAIL') ?? '']];
  for (const [key, label, def] of questions) {
    const answer = (await ask(`${label}${def ? ` [${def}]` : ''}: `)).trim();
    if (answer && answer !== def) {
      answers.set(key, answer);
    }
  }
  return answers;
}

/**
 * Run the CLI. Pure with respect to its injected `io`, so tests drive it directly.
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  const out = io.out ?? ((s) => process.stdout.write(`${s}\n`));
  const err = io.err ?? ((s) => process.stderr.write(`${s}\n`));
  const rand = io.rand ?? randomBytes;
  const now = io.now ?? new Date();

  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args: argv,
      options: {
        'dry-run': { type: 'boolean' },
        file: { default: '.env', type: 'string' },
        help: { short: 'h', type: 'boolean' },
        profile: { default: 'local', type: 'string' },
        set: { multiple: true, type: 'string' },
        template: { default: '.env.example', type: 'string' },
        yes: { short: 'y', type: 'boolean' },
      },
    });
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  const { positionals, values: opts } = parsed;
  const command = positionals[0];
  if (opts.help || !['init', 'sync', 'check'].includes(command)) {
    (opts.help ? out : err)(USAGE);
    return opts.help ? 0 : 2;
  }
  if (!['local', 'prod'].includes(opts.profile)) {
    err('--profile must be "local" or "prod"');
    return 2;
  }
  const profile = opts.profile;
  const file = resolve(ROOT, opts.file);
  const templatePath = resolve(ROOT, opts.template);
  const templateText = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : null;

  if (command === 'check') {
    if (!existsSync(file)) {
      err(`${opts.file} does not exist; run \`env:setup init\``);
      return 1;
    }
    const templateKeys = templateText
      ? [
          ...new Set(
            parseEnv(templateText)
              .filter((i) => i.type === 'kv')
              .map((i) => i.key)
          ),
        ]
      : [];
    const { errors, warnings } = checkEnv(parseValues(readFileSync(file, 'utf8')), {
      profile,
      templateKeys,
    });
    for (const w of warnings) {
      out(`warn  ${w}`);
    }
    for (const e of errors) {
      out(`FAIL  ${e}`);
    }
    out(
      errors.length === 0
        ? `${opts.file}: ok (${warnings.length} warning${warnings.length === 1 ? '' : 's'})`
        : `${opts.file}: ${errors.length} problem${errors.length === 1 ? '' : 's'}`
    );
    return errors.length === 0 ? 0 : 1;
  }

  if (!templateText) {
    err(`template ${opts.template} not found`);
    return 1;
  }
  const exists = existsSync(file);
  if (command === 'init' && exists) {
    err(`${opts.file} already exists; run \`env:setup sync\` to update it`);
    return 1;
  }
  if (command === 'sync' && !exists) {
    err(`${opts.file} does not exist; run \`env:setup init\``);
    return 1;
  }

  let sets;
  try {
    sets = parseSets(opts.set ?? []);
  } catch (e) {
    err(e.message);
    return 2;
  }

  const existing = exists ? readFileSync(file, 'utf8') : '';
  const tItems = parseEnv(templateText);
  const base = new Map();
  for (const item of tItems) {
    if (item.type === 'kv') {
      base.set(item.key, item.value);
    }
  }
  for (const [k, v] of parseValues(existing)) {
    base.set(k, v);
  }
  const userKeys = parseValues(existing);

  if (userKeys.get('CONFIG_ENCRYPTION_KEY') && sets.has('CONFIG_ENCRYPTION_KEY')) {
    if (sets.get('CONFIG_ENCRYPTION_KEY') !== userKeys.get('CONFIG_ENCRYPTION_KEY')) {
      err(
        'refusing to replace CONFIG_ENCRYPTION_KEY: use `yarn keys:rotate` (see docs/model-configuration.md)'
      );
      return 1;
    }
  }

  const interactive =
    command === 'init' && !opts.yes && (io.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY));
  if (interactive) {
    const rl = io.ask ? null : createInterface({ input: process.stdin, output: process.stdout });
    try {
      const defaults = new Map();
      for (const item of tItems) {
        if (item.key && !defaults.has(item.key)) {
          defaults.set(item.key, item.valueRaw.split('#')[0].trim());
        }
      }
      const answers = await promptAnswers({
        ask: io.ask ?? ((q) => rl.question(q)),
        defaults,
        profile,
      });
      for (const [k, v] of answers) {
        if (!sets.has(k)) {
          sets.set(k, v);
        }
      }
    } finally {
      rl?.close();
    }
  }

  const { overrides, generated } = planValues(base, { mode: command, profile, rand, sets });
  // Only overrides that actually change something should show up as set/generated.
  const { report, text } = renderEnv(templateText, existing, overrides);

  if (opts['dry-run']) {
    const diff = unifiedDiff(maskEnv(existing), maskEnv(text));
    out(diff === '' ? '(no changes)' : diff);
  } else {
    if (exists && text !== existing) {
      const backup = `${file}.bak-${timestamp(now)}`;
      copyFileSync(file, backup);
      chmodSync(backup, 0o600);
      out(`backup  ${backup}`);
    }
    if (!exists || text !== existing) {
      writeFileSync(file, text, { mode: 0o600 });
    }
    chmodSync(file, 0o600);
  }

  const verb = opts['dry-run'] ? 'would be' : 'was';
  const outcome =
    command === 'init'
      ? `${verb} created`
      : text === existing
        ? 'is up to date'
        : `${verb} updated`;
  out(`${opts.file} ${outcome} (${profile} profile)`);
  const list = (label, items) => {
    if (items.length > 0) {
      out(`${label}: ${items.join(', ')}`);
    }
  };
  if (command === 'sync') {
    list('added keys', report.added);
    out(`carried over: ${report.carried} value${report.carried === 1 ? '' : 's'}`);
    list('local additions', report.localAdditions);
    list('renamed', report.renamed);
  }
  list('generated', generated);
  if (command === 'init') {
    out('next: run `yarn env:setup check` to verify, then `yarn db:deploy`');
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
