#!/usr/bin/env node
/**
 * `docker compose` with profiles ADDED to `COMPOSE_PROFILES`, not substituted
 * for it.
 *
 *   node scripts/compose.mjs [--add-profile <name>]... <compose args>
 *
 * Compose treats `--profile` as a replacement for `COMPOSE_PROFILES`: once the
 * flag is on the command line, the variable — and so the `objectstore` switch
 * in `.env` — is ignored. The local scripts used to pass
 * `--profile temporal-ui`, so the bundled Garage store never started through
 * them. This wrapper reads `COMPOSE_PROFILES` the way Compose does (shell
 * first, then the repository `.env`), appends each `--add-profile`, and runs
 * Compose with the union in the environment.
 *
 * Zero dependencies, like the other scripts here, so it runs before
 * `yarn install`.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Split leading `--add-profile <name>` / `--add-profile=<name>` flags from the Compose arguments. */
export function splitArgs(argv) {
  const add = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--add-profile') {
      if (argv[i + 1] === undefined) {
        throw new Error('--add-profile needs a profile name');
      }
      add.push(argv[i + 1]);
      i += 2;
    } else if (arg.startsWith('--add-profile=')) {
      add.push(arg.slice('--add-profile='.length));
      i += 1;
    } else {
      break;
    }
  }
  return { add, rest: argv.slice(i) };
}

/**
 * The profiles Compose would read on its own: a `COMPOSE_PROFILES` in the
 * shell environment wins — even when empty — over the one in `.env`.
 */
export function baseProfiles(env, dotenvText) {
  if (env.COMPOSE_PROFILES !== undefined) {
    return env.COMPOSE_PROFILES;
  }
  return dotenvText === undefined ? '' : (parseEnv(dotenvText).COMPOSE_PROFILES ?? '');
}

/** Comma-joined union, first occurrence wins the position, blanks dropped. */
export function mergeProfiles(base, add) {
  const names = [...base.split(','), ...add].map((p) => p.trim()).filter(Boolean);
  return [...new Set(names)].join(',');
}

function main(argv) {
  const { add, rest } = splitArgs(argv);
  const dotenvPath = resolve(ROOT, '.env');
  const dotenvText = existsSync(dotenvPath) ? readFileSync(dotenvPath, 'utf8') : undefined;
  const profiles = mergeProfiles(baseProfiles(process.env, dotenvText), add);
  const child = spawn('docker', ['compose', ...rest], {
    cwd: ROOT,
    env: { ...process.env, COMPOSE_PROFILES: profiles },
    stdio: 'inherit',
  });
  child.on('error', (err) => {
    console.error(`compose: could not run docker: ${err.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2));
}
