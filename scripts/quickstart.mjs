#!/usr/bin/env node
/**
 * One-command local bring-up: `.env`, infrastructure, database, model
 * configuration, then the gateway, worker and dashboard.
 *
 *   node scripts/quickstart.mjs [up] [options]
 *   node scripts/quickstart.mjs down
 *   yarn quickstart [up|down] [options]
 *
 * Zero dependencies (Node built-ins only), like env-setup.mjs and compose.mjs,
 * so the first thing it does can be `yarn install`. Every step shells out to the
 * command a person would otherwise type from the quickstart doc; this file holds
 * only the order, the readiness waits, and the decisions a doc cannot make.
 *
 * Secrets: provider API keys are read from environment variables (named by
 * flag, never passed as a value on the command line, where `ps` shows them) and
 * handed to the one child process that stores them encrypted in the database.
 * They are not written to `.env` or anywhere in the repository.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = '.quickstart';

export const MIN_NODE_MAJOR = 26;
export const DEFAULT_KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };
export const SERVICES = ['gateway', 'worker', 'web'];
export const GATEWAY_URL = 'http://localhost:8080';
export const WEB_URL = 'http://localhost:3000';

const USAGE = `Usage: yarn quickstart [up|down] [options]

  up (default)   create .env, start infrastructure, prepare the database, store
                 model credentials, start the gateway, worker and dashboard
  down           stop the three services and the infrastructure containers
                 (data is kept)

Options:
  --check                 report what would happen and what is missing; change nothing
  --anthropic-key-env V   environment variable holding the Anthropic API key (default ${DEFAULT_KEY_ENV.anthropic})
  --openai-key-env V      environment variable holding the OpenAI API key, used for
                          embeddings (default ${DEFAULT_KEY_ENV.openai})
  --single-postgres       evaluation only: Temporal shares the application's Postgres
                          (see docs/quickstart.md)
  --no-start              stop after the database and model configuration
  --skip-install          do not run \`yarn install --immutable\`
  -h, --help              this text
`;

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/** Parse argv into options; `error` is set instead when the arguments are unusable. */
export function parseQuickstartArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      args: argv,
      options: {
        'anthropic-key-env': { type: 'string' },
        check: { type: 'boolean' },
        help: { short: 'h', type: 'boolean' },
        'no-start': { type: 'boolean' },
        'openai-key-env': { type: 'string' },
        'single-postgres': { type: 'boolean' },
        'skip-install': { type: 'boolean' },
      },
    });
  } catch (e) {
    return { error: e.message };
  }
  const { positionals, values } = parsed;
  const command = positionals[0] ?? 'up';
  if (positionals.length > 1 || !['up', 'down'].includes(command)) {
    return { error: `unknown command "${positionals.join(' ')}"` };
  }
  for (const flag of ['anthropic-key-env', 'openai-key-env']) {
    const name = values[flag];
    if (name !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return {
        error: `--${flag} takes the NAME of an environment variable, not a key (got a value that is not a valid name)`,
      };
    }
  }
  return {
    options: {
      anthropicKeyEnv: values['anthropic-key-env'] ?? DEFAULT_KEY_ENV.anthropic,
      check: values.check === true,
      command,
      help: values.help === true,
      noStart: values['no-start'] === true,
      openaiKeyEnv: values['openai-key-env'] ?? DEFAULT_KEY_ENV.openai,
      singlePostgres: values['single-postgres'] === true,
      skipInstall: values['skip-install'] === true,
    },
  };
}

/** The Node.js major version in a `process.version` string, or NaN. */
export function nodeMajor(version) {
  return Number.parseInt(String(version).replace(/^v/, ''), 10);
}

/** Problems that stop the bring-up before it changes anything. Empty when ready. */
export function preflightProblems({ nodeVersion, dockerOk, yarnOk }) {
  const problems = [];
  if (!(nodeMajor(nodeVersion) >= MIN_NODE_MAJOR)) {
    problems.push(
      `Node.js ${MIN_NODE_MAJOR} or later is required (found ${nodeVersion}). Install it, then \`npm install -g corepack && corepack enable\`.`
    );
  }
  if (!yarnOk) {
    problems.push(
      '`yarn` is not available. Run `npm install -g corepack && corepack enable` (Node 26 does not bundle Corepack).'
    );
  }
  if (!dockerOk) {
    problems.push('Docker is not reachable. Start Docker (`docker info` must succeed).');
  }
  return problems;
}

/** Read the two provider keys from `env` by the variable names in `options`. */
export function resolveKeys(env, options) {
  const read = (name) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  return {
    anthropic: read(options.anthropicKeyEnv),
    openai: read(options.openaiKeyEnv),
  };
}

/** Providers the worker needs a key for that the environment did not supply. */
export function missingProviders(keys) {
  return ['anthropic', 'openai'].filter((p) => !keys[p]);
}

/** Arguments to `scripts/compose.mjs` for the infrastructure stack. */
export function composeArgs({ singlePostgres }) {
  const files = ['-f', 'docker-compose.infra.yml'];
  if (singlePostgres) {
    files.push('-f', 'docker-compose.single-postgres.yml');
  }
  return ['scripts/compose.mjs', '--add-profile', 'temporal-ui', ...files];
}

/**
 * The ordered steps of `up`. Each is `{ id, label, run }` where `run` is a
 * command to spawn, or `fn` names a built-in action. `skip` carries the reason a
 * step does not apply, shown in the plan.
 */
export function buildPlan(options, state) {
  const compose = composeArgs(options);
  const node = process.execPath;
  const steps = [
    {
      id: 'env',
      label: state.envExists
        ? 'validate .env (yarn env:setup check)'
        : 'create .env with generated secrets (yarn env:setup init)',
      run: [node, ['scripts/env-setup.mjs', state.envExists ? 'check' : 'init', '--yes']],
    },
    {
      id: 'install',
      label: 'install dependencies (yarn install --immutable)',
      run: ['yarn', ['install', '--immutable']],
      skip: options.skipInstall
        ? '--skip-install'
        : state.depsInstalled
          ? 'node_modules present'
          : undefined,
    },
    {
      id: 'infra',
      label: options.singlePostgres
        ? 'start infrastructure, Temporal sharing the application Postgres'
        : 'start infrastructure (Postgres, Temporal, Temporal UI, object store)',
      run: [node, [...compose, 'up', '-d']],
    },
    { fn: 'waitInfra', id: 'wait-infra', label: 'wait for Postgres and the Temporal namespace' },
    { id: 'db-deploy', label: 'apply migrations (yarn db:deploy)', run: ['yarn', ['db:deploy']] },
    { id: 'db-generate', label: 'generate the Prisma client', run: ['yarn', ['db:generate']] },
    {
      id: 'db-seed',
      label: 'seed admin, team, templates, agents (yarn db:seed)',
      run: ['yarn', ['db:seed']],
    },
    {
      id: 'model-config',
      label: 'store model credentials and the embedding configuration',
      passKeys: true,
      run: [
        'yarn',
        [
          'workspace',
          '@auto-swe/shared',
          'exec',
          'tsx',
          '--env-file=../../.env',
          'src/scripts/seedQuickstart.ts',
        ],
      ],
      skip: state.missing.length === 2 ? 'no provider key in the environment' : undefined,
    },
  ];
  const noStart = options.noStart ? '--no-start' : undefined;
  steps.push(
    {
      fn: 'startService',
      id: 'start-gateway',
      label: 'start the gateway (:8080)',
      service: 'gateway',
      skip: noStart,
    },
    {
      fn: 'startService',
      id: 'start-web',
      label: 'start the dashboard (:3000)',
      service: 'web',
      skip: noStart,
    },
    {
      fn: 'startService',
      id: 'start-worker',
      label: 'start the worker',
      service: 'worker',
      skip:
        noStart ??
        (state.missing.length > 0
          ? `no ${state.missing.join(' / ')} key: the worker would refuse to start`
          : undefined),
    }
  );
  return steps;
}

/**
 * Container states from `docker compose ps --all --format json`: newline-
 * delimited objects on some Compose versions, one array on others.
 */
export function parseComposeState(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const whole = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    return trimmed
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

/** Whether the one-shot namespace job finished successfully. */
export function namespaceReady(containers) {
  const job = containers.find((c) => c.Service === 'temporal-setup-namespace');
  return job !== undefined && job.State === 'exited' && job.ExitCode === 0;
}

/** Whether a long-running service reports healthy (or running, when it has no healthcheck). */
export function serviceHealthy(containers, service) {
  const c = containers.find((x) => x.Service === service);
  if (c?.State !== 'running') {
    return false;
  }
  return c.Health === undefined || c.Health === '' || c.Health === 'healthy';
}

/** Poll `probe` until it returns truthy or `timeoutMs` passes. Returns whether it succeeded. */
export async function waitUntil(probe, { timeoutMs, intervalMs, sleep, now }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = now ?? Date.now;
  const deadline = clock() + timeoutMs;
  for (;;) {
    if (await probe()) {
      return true;
    }
    if (clock() >= deadline) {
      return false;
    }
    await wait(intervalMs);
  }
}

/** Why a worker log says the worker is not (yet) running, or null while it looks fine. */
export function workerLogVerdict(log) {
  if (log.includes('Worker started, polling task queue')) {
    return 'ready';
  }
  if (log.includes('LLM configuration incomplete')) {
    return 'config-incomplete';
  }
  return 'pending';
}

/** The text printed once everything that can start has started. */
export function nextSteps({ started, missing, envFile = '.env' }) {
  const lines = ['', 'auto-swe is up.', ''];
  lines.push(`  Dashboard   ${WEB_URL}`);
  lines.push(`  Gateway     ${GATEWAY_URL}/health`);
  lines.push('  Temporal UI http://localhost:8233');
  lines.push(
    `  Sign in as  admin@auto-swe.local (or SEED_ADMIN_EMAIL); the password is SEED_ADMIN_PASSWORD in ${envFile}`
  );
  lines.push('');
  if (missing.length > 0) {
    lines.push(
      `The worker is NOT running: no ${missing.join(' or ')} API key was in the environment.`,
      '  Add the key(s) at Build > Model configuration (/models), or re-run with the key exported:',
      '    ANTHROPIC_API_KEY=... OPENAI_API_KEY=... yarn quickstart',
      '  then `yarn dev:worker`.',
      ''
    );
  } else if (!started.includes('worker')) {
    lines.push('The worker was not started. Run `yarn dev:worker` when you are ready.', '');
  }
  lines.push(
    'First run on a sample repository:',
    '  1. Admin > Integrations > GitHub (/admin/integrations): enter a token that can open a pull request',
    '     on a repository you do not mind receiving one (or set GITHUB_TOKEN in .env and restart the gateway).',
    '  2. Connections (/connections): add that repository as a Git repo connection.',
    '  3. + New request: template ticket-to-merge, that repository, and a small change such as',
    '     "add a GET /health endpoint that returns { status: \'ok\' }".',
    '  4. Watch it at /runs. It ends with a pull request; a person merges it.',
    '',
    'Logs: .quickstart/<service>.log.  Stop: yarn quickstart down.',
    ''
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Side effects
// ---------------------------------------------------------------------------

const log = (s) => process.stdout.write(`${s}\n`);

function commandWorks(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'ignore' }).status === 0;
}

function inspectHost() {
  return {
    dockerOk: commandWorks('docker', ['info']),
    nodeVersion: process.version,
    yarnOk: commandWorks('yarn', ['--version']),
  };
}

function tcpOpen(port) {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

function composePs(options) {
  const r = spawnSync(
    process.execPath,
    [...composeArgs(options), 'ps', '--all', '--format', 'json'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    }
  );
  return r.status === 0 ? parseComposeState(r.stdout) : [];
}

/**
 * The environment a child process gets: the caller's, minus the provider keys. Model credentials
 * live encrypted in the database, so a service that inherited one would silently gain an
 * environment fallback the platform does not intend.
 */
function childEnv() {
  const env = { ...process.env };
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    delete env[name];
  }
  return env;
}

function runStep(step, keys) {
  const [cmd, args] = step.run;
  const env = childEnv();
  if (step.passKeys) {
    env.QUICKSTART_ANTHROPIC_API_KEY = keys.anthropic ?? '';
    env.QUICKSTART_OPENAI_API_KEY = keys.openai ?? '';
  }
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit' });
  return r.status === 0;
}

function pidFile(service) {
  return resolve(ROOT, STATE_DIR, `${service}.pid`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function recordedPid(service) {
  try {
    const pid = Number.parseInt(readFileSync(pidFile(service), 'utf8'), 10);
    return Number.isInteger(pid) && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function startService(service) {
  if (recordedPid(service) !== null) {
    log(`  ${service}: already running (pid ${recordedPid(service)})`);
    return;
  }
  const logPath = resolve(ROOT, STATE_DIR, `${service}.log`);
  const fd = openSync(logPath, 'w');
  const child = spawn('yarn', [`dev:${service}`], {
    cwd: ROOT,
    detached: true,
    env: childEnv(),
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);
  writeFileSync(pidFile(service), String(child.pid));
}

async function gatewayHealthy() {
  try {
    const res = await fetch(`${GATEWAY_URL}/health`, {
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitInfra(options) {
  const ok = await waitUntil(
    async () => {
      const containers = composePs(options);
      return (
        serviceHealthy(containers, 'postgres') &&
        serviceHealthy(containers, 'temporal') &&
        namespaceReady(containers) &&
        (await tcpOpen(5432)) &&
        (await tcpOpen(7233))
      );
    },
    { intervalMs: 3000, timeoutMs: 180_000 }
  );
  if (!ok) {
    log(
      'Infrastructure did not become ready in 3 minutes. `docker compose ps` and the container logs say why.'
    );
  }
  return ok;
}

async function waitService(service) {
  if (service === 'gateway') {
    return waitUntil(gatewayHealthy, { intervalMs: 2000, timeoutMs: 120_000 });
  }
  if (service === 'web') {
    return waitUntil(
      async () => {
        try {
          return (
            (await fetch(WEB_URL, { redirect: 'manual', signal: AbortSignal.timeout(2000) }))
              .status < 500
          );
        } catch {
          return false;
        }
      },
      { intervalMs: 2000, timeoutMs: 180_000 }
    );
  }
  let verdict = 'pending';
  await waitUntil(
    async () => {
      try {
        verdict = workerLogVerdict(readFileSync(resolve(ROOT, STATE_DIR, 'worker.log'), 'utf8'));
      } catch {
        verdict = 'pending';
      }
      return verdict !== 'pending';
    },
    { intervalMs: 2000, timeoutMs: 120_000 }
  );
  return verdict === 'ready';
}

function readState() {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, STATE_DIR, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

async function down(options) {
  const stateFile = readState();
  const singlePostgres = options.singlePostgres || stateFile.singlePostgres === true;
  for (const service of SERVICES) {
    const pid = recordedPid(service);
    if (pid !== null) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
      log(`stopped ${service}`);
    }
    rmSync(pidFile(service), { force: true });
  }
  const r = spawnSync(process.execPath, [...composeArgs({ singlePostgres }), 'down'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return r.status === 0 ? 0 : 1;
}

/**
 * Run the CLI.
 * @returns {Promise<number>} exit code
 */
export async function main(argv, env = process.env) {
  const parsed = parseQuickstartArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { options } = parsed;
  if (options.help) {
    log(USAGE);
    return 0;
  }
  if (options.command === 'down') {
    return down(options);
  }

  const keys = resolveKeys(env, options);
  const state = {
    depsInstalled: existsSync(resolve(ROOT, 'node_modules')),
    envExists: existsSync(resolve(ROOT, '.env')),
    missing: missingProviders(keys),
  };
  const plan = buildPlan(options, state);
  const problems = preflightProblems(inspectHost());

  if (options.check) {
    log('quickstart plan (nothing is changed by --check):');
    plan.forEach((step, i) => {
      log(`  ${i + 1}. ${step.label}${step.skip ? `  [skipped: ${step.skip}]` : ''}`);
    });
    log('');
    log(
      `keys: anthropic ${keys.anthropic ? `found in ${options.anthropicKeyEnv}` : `missing (${options.anthropicKeyEnv})`}, openai ${keys.openai ? `found in ${options.openaiKeyEnv}` : `missing (${options.openaiKeyEnv})`}`
    );
    for (const p of problems) {
      log(`problem: ${p}`);
    }
    log(problems.length === 0 ? 'host: ready' : 'host: not ready');
    return problems.length === 0 ? 0 : 1;
  }

  if (problems.length > 0) {
    for (const p of problems) {
      process.stderr.write(`${p}\n`);
    }
    return 1;
  }

  mkdirSync(resolve(ROOT, STATE_DIR), { recursive: true });
  writeFileSync(
    resolve(ROOT, STATE_DIR, 'state.json'),
    JSON.stringify({ singlePostgres: options.singlePostgres })
  );

  const started = [];
  for (const [i, step] of plan.entries()) {
    const prefix = `[${i + 1}/${plan.length}]`;
    if (step.skip) {
      log(`${prefix} skip: ${step.label} (${step.skip})`);
      continue;
    }
    log(`${prefix} ${step.label}`);
    let ok = true;
    if (step.run) {
      ok = runStep(step, keys);
    } else if (step.fn === 'waitInfra') {
      ok = await waitInfra(options);
    } else if (step.fn === 'startService') {
      startService(step.service);
      ok = await waitService(step.service);
      if (ok) {
        started.push(step.service);
      } else if (step.service === 'worker') {
        log(`  The worker did not report ready; see ${STATE_DIR}/worker.log.`);
      }
    }
    if (!ok) {
      process.stderr.write(
        `\nStopped at step ${i + 1} (${step.label}). Fix the cause and re-run \`yarn quickstart\`; every step is safe to repeat.\n`
      );
      return 1;
    }
  }
  log(nextSteps({ missing: state.missing, started }));
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
