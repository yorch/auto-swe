#!/usr/bin/env node
/**
 * Local twin of the CI step "Verify migrations match schema.prisma".
 *
 *   yarn migrations:check
 *
 * Starts a throwaway Postgres+pgvector container, applies every migration with
 * `prisma migrate deploy`, then diffs that database against schema.prisma with
 * the same `prisma migrate diff` and the same allowance CI uses: the two known
 * hand-written `DROP INDEX` statements (.claude/skills/prisma-pgvector-hnsw) and
 * nothing else. A schema edit without a migration fails here instead of in CI.
 *
 * Exit codes: 0 the migrations match, 1 drift (or a migration that does not
 * apply), 2 the environment could not run the check (no Docker, no container).
 *
 * The container has no volume and no bind mount (the data directory is a tmpfs),
 * so nothing is left in the working tree. It is removed with `docker rm -fv` on
 * every exit path and on SIGINT/SIGTERM, by its unique name, so a signal that arrives
 * before the container id is known still removes it. A SIGKILL cannot be trapped, so
 * each run first sweeps labelled containers left by dead runs; it never touches one
 * whose owner is alive and younger than 30 minutes, so runs may overlap.
 *
 * Every child process gets DATABASE_URL explicitly. Before anything runs, the
 * script evaluates prisma.config.ts in a child with that exact environment and
 * refuses to continue unless the datasource URL it resolves points at the
 * container: the config loads the repository `.env`, and this must never touch a
 * developer's database.
 *
 * Not covered, which the CI job also does: `yarn db:generate`, the seed, and
 * re-applying migrations (idempotency).
 *
 * Zero dependencies, like the other scripts here.
 */

import { spawn } from 'node:child_process';
import { readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = path.join(ROOT, 'packages/shared');
const MIGRATIONS = path.join(SHARED, 'src/prisma/migrations');

/** The image CI's `migrations` job and docker-compose.infra.yml run. */
export const IMAGE = 'pgvector/pgvector:pg18';
export const LABEL = 'auto-swe-migrations-check=1';
/** Per-run label, `<pid>-<epoch ms>`; the sweep uses it to leave live runs alone. */
export const RUN_LABEL_KEY = 'auto-swe-migrations-check-run';
/** A container older than this is stale whatever its pid says. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

const DB = { name: 'ci', password: 'ci', user: 'ci' };

/**
 * The statements the diff is allowed to contain, character for character as in
 * .github/workflows/ci.yml. Keep the two lists identical.
 */
export const EXPECTED = [
  'DROP INDEX "idx_memory_items_embedding";',
  'DROP INDEX "knowledge_items_embedding_hnsw_idx";',
];

/**
 * CI's filter: `grep -Ev '^[[:space:]]*(--.*)?$'` drops blank and comment-only
 * lines, then `grep -vxF -e A -e B` drops lines that equal an expected statement
 * in full. What is left is the unexpected diff.
 */
export function unexpectedDiff(sql, expected = EXPECTED) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*(--.*)?$/.test(line))
    .filter((line) => !expected.includes(line));
}

/** The `host:port` of a published port, from `docker port <id> 5432/tcp` output. */
export function parsePublishedPort(output) {
  for (const line of output.split('\n')) {
    const match = /^127\.0\.0\.1:(\d+)$/.exec(line.trim());
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

export function databaseUrl(port) {
  return `postgresql://${DB.user}:${DB.password}@127.0.0.1:${port}/${DB.name}`;
}

/**
 * Throws unless `url` names exactly `127.0.0.1:<port>`. Called on the environment of
 * every child process before it starts.
 */
export function assertTargetsContainer(url, port) {
  let parsed;
  try {
    parsed = new URL(url ?? '');
  } catch {
    throw new Error('DATABASE_URL is missing or not a URL');
  }
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== String(port)) {
    throw new Error(
      `refusing to run: DATABASE_URL points at ${parsed.hostname}:${parsed.port}, ` +
        `not the check container at 127.0.0.1:${port}`
    );
  }
}

export class EnvironmentError extends Error {}

/**
 * Which labelled containers a new run may remove. `rows` are `{ id, runLabel }`.
 * A container is stale when its label is missing or unreadable, its owner pid is
 * not alive, or it is older than `maxAgeMs`; a fresh one with a live owner is a
 * concurrent run and is kept.
 */
export function selectStale(rows, { now, isAlive, maxAgeMs = STALE_AFTER_MS }) {
  return rows
    .filter(({ runLabel }) => {
      const match = /^(\d+)-(\d+)$/.exec(runLabel ?? '');
      if (!match) {
        return true;
      }
      const [, pid, epoch] = match;
      return now - Number(epoch) > maxAgeMs || !isAlive(Number(pid));
    })
    .map(({ id }) => id);
}

/** Parse `docker ps --format '{{.ID}} {{.Label "<key>"}}'` output. */
export function parseContainerRows(output) {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, runLabel] = line.split(/\s+/);
      return { id, runLabel: runLabel ?? '' };
    });
}

/**
 * One teardown for the whole process: `finally`, the signal handlers and a second
 * Ctrl-C all await the same removal, so none of them can skip it or race it.
 */
export function createTeardown(removeByName) {
  let pending = null;
  return () => {
    pending ??= Promise.resolve().then(removeByName);
    return pending;
  };
}

/** Run a command, collecting output; never rejects on a non-zero exit. */
function run(cmd, args, { cwd = ROOT, env = process.env, children } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children?.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      children?.delete(child);
      resolve({ code: code ?? 1, stderr, stdout });
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

const RESOLVE_URL_SCRIPT =
  'const m = await import(process.argv[1]); process.stdout.write(String(m.default.datasource.url));';

function defaultDeps() {
  return {
    isAlive: pidAlive,
    migrationCount: () =>
      readdirSync(MIGRATIONS, { withFileTypes: true }).filter((e) => e.isDirectory()).length,
    now: () => Date.now(),
    pid: process.pid,
    proc: process,
    run,
    sleep,
  };
}

export async function main(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const children = new Set();
  const runId = `${deps.pid}-${deps.now()}`;
  const name = `auto-swe-migcheck-${runId}`;
  const sh = (cmd, args, opts) => deps.run(cmd, args, { children, ...opts });

  const teardown = createTeardown(async () => {
    await deps.run('docker', ['rm', '-fv', name]).catch(() => undefined);
  });
  const handlers = [];
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    const handler = async () => {
      for (const child of children) {
        child.kill('SIGTERM');
      }
      console.error(`\n${signal}: removing the check container`);
      await teardown();
      deps.proc.exit(code);
    };
    deps.proc.on(signal, handler);
    handlers.push([signal, handler]);
  }

  // Probe used both for readiness and, after a failed prisma command, to tell an
  // environment failure (container gone or unreachable) from a real verdict.
  const reachable = async () => {
    const state = await sh('docker', ['inspect', '-f', '{{.State.Running}}', name]);
    if (state.code !== 0 || state.stdout.trim() !== 'true') {
      return false;
    }
    const probe = await sh('docker', [
      'exec',
      name,
      'pg_isready',
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
      '-U',
      DB.user,
      '-d',
      DB.name,
    ]);
    return probe.code === 0;
  };

  try {
    const info = await sh('docker', ['info']).catch(() => ({ code: 127 }));
    if (info.code !== 0) {
      throw new EnvironmentError('docker is not installed or its daemon is not running');
    }

    const listed = await sh('docker', [
      'ps',
      '-a',
      '--filter',
      `label=${LABEL}`,
      '--format',
      `{{.ID}} {{.Label "${RUN_LABEL_KEY}"}}`,
    ]);
    const stale = selectStale(parseContainerRows(listed.stdout), {
      isAlive: deps.isAlive,
      now: deps.now(),
    });
    if (stale.length > 0) {
      await sh('docker', ['rm', '-fv', ...stale]);
      console.error(`removed ${stale.length} stale check container(s) from earlier runs`);
    }

    const started = await sh('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--label',
      LABEL,
      '--label',
      `${RUN_LABEL_KEY}=${runId}`,
      '--tmpfs',
      '/var/lib/postgresql',
      '-p',
      '127.0.0.1::5432',
      '-e',
      `POSTGRES_USER=${DB.user}`,
      '-e',
      `POSTGRES_PASSWORD=${DB.password}`,
      '-e',
      `POSTGRES_DB=${DB.name}`,
      IMAGE,
    ]);
    if (started.code !== 0) {
      throw new EnvironmentError(`could not start ${IMAGE}:\n${started.stderr.trim()}`);
    }

    const published = await sh('docker', ['port', name, '5432/tcp']);
    const port = parsePublishedPort(published.stdout);
    if (port === null) {
      throw new EnvironmentError(`could not read the published port:\n${published.stdout}`);
    }
    console.error(`check database: ${name} on 127.0.0.1:${port}`);

    // `pg_isready -h 127.0.0.1` is the real probe: the entrypoint's temporary init
    // server listens on the unix socket only, so it fails until the final server is
    // up. (A host-side TCP connect would say nothing, as docker's proxy accepts
    // loopback connections before the server does.)
    const deadline = deps.now() + 90_000;
    while (!(await reachable())) {
      if (deps.now() > deadline) {
        throw new EnvironmentError('the Postgres container did not become ready within 90 seconds');
      }
      await deps.sleep(500);
    }

    const env = {
      ...process.env,
      DATABASE_URL: databaseUrl(port),
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    };

    // Pre-flight: what will prisma actually connect to? Evaluate its config with the
    // exact environment the commands get, and refuse unless that is the container.
    // Through `yarn node`, as the real commands go through `yarn prisma`, so both see the
    // environment Yarn builds (it may load `.env.yarn` files).
    const resolved = await sh(
      'yarn',
      [
        'node',
        '--input-type=module',
        '-e',
        RESOLVE_URL_SCRIPT,
        pathToFileURL(path.join(SHARED, 'prisma.config.ts')).href,
      ],
      { cwd: SHARED, env }
    );
    if (resolved.code !== 0) {
      throw new EnvironmentError(
        `could not resolve the datasource from prisma.config.ts:\n${resolved.stderr}`
      );
    }
    assertTargetsContainer(resolved.stdout.trim(), port);

    const prisma = (args) => sh('yarn', ['prisma', ...args], { cwd: SHARED, env });
    // A failing prisma command is a verdict on the migrations only if the database
    // was there to give one.
    const failed = async (message, result) => {
      if (!(await reachable())) {
        throw new EnvironmentError('the check container went away while prisma was running');
      }
      console.error(`${result.stdout}${result.stderr}`);
      console.error(message);
      return 1;
    };

    console.error('applying migrations (prisma migrate deploy)...');
    const deploy = await prisma(['migrate', 'deploy']);
    if (deploy.code !== 0) {
      return await failed('A migration does not apply to a fresh database.', deploy);
    }

    // Prove the deploy reached the container and not some other database.
    const expectedCount = deps.migrationCount();
    const counted = await sh('docker', [
      'exec',
      name,
      'psql',
      '-U',
      DB.user,
      '-d',
      DB.name,
      '-tAc',
      'select count(*) from _prisma_migrations where finished_at is not null',
    ]);
    if (counted.code !== 0 || Number(counted.stdout.trim()) !== expectedCount) {
      throw new EnvironmentError(
        `the container records ${counted.stdout.trim() || 'no'} applied migrations, ` +
          `expected ${expectedCount}: the deploy did not run against it`
      );
    }

    const diff = await prisma([
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'src/prisma/schema.prisma',
      '--script',
    ]);
    if (diff.code !== 0) {
      return await failed('prisma migrate diff failed.', diff);
    }
    const unexpected = unexpectedDiff(diff.stdout);
    if (unexpected.length > 0) {
      console.error(
        'schema.prisma and the committed migrations disagree. Add a migration ' +
          '(see .claude/skills/prisma-pgvector-hnsw). Unexpected diff:'
      );
      console.error(unexpected.join('\n'));
      return 1;
    }
    console.error('Migrations match schema.prisma (only the known hand-written DDL differs).');
    console.error('Not checked here, as CI does: db:generate, the seed, re-applying migrations.');
    return 0;
  } catch (err) {
    // Anything thrown is the environment (no Docker, no container, a refused URL),
    // never a verdict on the migrations.
    console.error(`migrations:check: ${err?.message ?? err}`);
    return 2;
  } finally {
    await teardown();
    for (const [signal, handler] of handlers) {
      deps.proc.off(signal, handler);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  main().then((code) => {
    process.exit(code);
  });
}
