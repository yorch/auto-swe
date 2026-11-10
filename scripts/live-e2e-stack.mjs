#!/usr/bin/env node
/**
 * Provisions a freshly started auto-swe stack for the live end-to-end suites.
 *
 * `.github/workflows/live-e2e.yml` brings up the infrastructure, migrates and seeds the database,
 * and starts the gateway and worker; this script then does what an operator does in the dashboard
 * (docs/quickstart.md steps 6 and 7) and seeds the fixture repository:
 *
 *   1. signs in as the seeded admin,
 *   2. stores the Anthropic and OpenAI credentials,
 *   3. turns on the MCP endpoint and its device flow (`mcp.enabled`, `mcp.deviceFlowEnabled`),
 *   4. onboards the fixture repository as a connection on the default team,
 *   5. issues a personal access token,
 *   6. pushes `infra/live-e2e/fixture/` to the fixture repository when it has no `package.json`,
 *   7. writes `LIVE_E2E_API_URL`, `LIVE_E2E_TOKEN` and `LIVE_E2E_REPO_ID` to `$GITHUB_ENV`
 *      (or prints them as `NAME=value` lines when it is not running in Actions).
 *
 * Every step is safe to repeat. Zero dependencies, so it runs before `yarn install` finishes
 * anywhere it is needed. See docs/live-checks.md.
 *
 * Usage: node scripts/live-e2e-stack.mjs bootstrap
 */

import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = join(ROOT, 'infra', 'live-e2e', 'fixture');

/** The names the bootstrap needs in its environment, and what each is for. */
export const REQUIRED_ENV = {
  ANTHROPIC_API_KEY: 'model credential for the seeded agents',
  GITHUB_TOKEN: 'fixture repository access (clone, push, pull request)',
  LIVE_E2E_FIXTURE_REPO: 'the fixture repository, as owner/name',
  OPENAI_API_KEY: 'embedding credential',
  SEED_ADMIN_PASSWORD: 'password of the seeded admin account',
};

/** The names in {@link REQUIRED_ENV} that `env` does not set. */
export function missingEnv(env) {
  return Object.keys(REQUIRED_ENV).filter((name) => !env[name]);
}

/** `owner/name` to its parts; throws on anything else. */
export function parseRepoSlug(slug) {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(slug ?? '');
  if (!m) {
    throw new Error(`LIVE_E2E_FIXTURE_REPO must look like owner/name, got "${slug}"`);
  }
  return { owner: m[1], repo: m[2] };
}

/** Every file under `dir` as `{ path, content }`, `path` relative with forward slashes. */
export function fixtureFiles(dir = FIXTURE_DIR) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else {
        out.push({
          content: readFileSync(full),
          path: relative(dir, full).split(sep).join('/'),
        });
      }
    }
  };
  walk(dir);
  return out;
}

/** Lines for `$GITHUB_ENV`: the token is masked first so it never reaches a log. */
export function envLines(values) {
  const lines = [];
  for (const [name, value] of Object.entries(values)) {
    if (/TOKEN/.test(name)) {
      lines.push({ mask: value });
    }
    lines.push({ env: `${name}=${value}` });
  }
  return lines;
}

async function api(base, method, path, { body, cookie, token } = {}) {
  const res = await fetch(`${base}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // better-auth refuses a sign-in without an origin it trusts.
      origin: base,
    },
    method,
    redirect: 'error',
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: the status and text below are what the caller reports.
  }
  return { headers: res.headers, json, status: res.status, text };
}

function must(res, what, ok = [200, 201]) {
  if (!ok.includes(res.status)) {
    throw new Error(`${what} failed: HTTP ${res.status} ${res.text.slice(0, 300)}`);
  }
  return res;
}

async function signIn(base, env) {
  const res = must(
    await api(base, 'POST', '/api/auth/sign-in/email', {
      body: {
        email: env.LIVE_E2E_ADMIN_EMAIL ?? 'admin@auto-swe.local',
        password: env.SEED_ADMIN_PASSWORD,
      },
    }),
    'sign-in'
  );
  const cookies = res.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) {
    throw new Error('sign-in returned no session cookie');
  }
  return cookie;
}

async function storeCredential(base, cookie, provider, apiKey) {
  const res = await api(base, 'POST', '/api/v1/platform/credentials', {
    body: { apiKey, provider, scope: 'GLOBAL' },
    cookie,
  });
  // 409: it is already there from an earlier run against the same database.
  must(res, `store ${provider} credential`, [200, 201, 409]);
}

/** Turn on the MCP endpoint and its device flow, which the OAuth discovery check reads. */
async function enableMcp(base, cookie) {
  for (const key of ['mcp.enabled', 'mcp.deviceFlowEnabled']) {
    must(
      await api(base, 'PUT', `/api/v1/platform/config/settings/${key}?scope=GLOBAL`, {
        body: { value: true },
        cookie,
      }),
      `enable ${key}`
    );
  }
}

async function ensureConnection(base, cookie, owner, repo, env) {
  const found = must(
    await api(base, 'GET', `/api/v1/repositories?q=${encodeURIComponent(repo)}`, { cookie }),
    'list repositories'
  );
  const existing = (found.json?.data ?? []).find(
    (r) => r.organizationName === owner && r.repoName === repo
  );
  if (existing) {
    return existing.id;
  }
  const teams = must(await api(base, 'GET', '/api/v1/teams', { cookie }), 'list teams');
  const team =
    (teams.json?.data ?? []).find((t) => t.id === env.LIVE_E2E_TEAM_ID) ??
    (teams.json?.data ?? []).find((t) => t.slug === 'default') ??
    (teams.json?.data ?? [])[0];
  if (!team) {
    throw new Error('no team to own the fixture repository connection');
  }
  const created = must(
    await api(base, 'POST', '/api/v1/repositories', {
      body: {
        defaultBranch: 'main',
        organizationName: owner,
        repoName: repo,
        teamId: team.id,
        type: 'git_repo',
      },
      cookie,
    }),
    'create repository connection'
  );
  return created.json.data.id;
}

async function issueToken(base, cookie) {
  const res = must(
    await api(base, 'POST', '/api/v1/auth/tokens', {
      body: { expiresInDays: 1, name: `live-e2e-${Date.now()}` },
      cookie,
    }),
    'issue token'
  );
  const token = res.json?.data?.token ?? res.json?.data?.plaintext;
  if (typeof token !== 'string') {
    throw new Error('the token response carries no plaintext token');
  }
  return token;
}

async function gh(env, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    method,
    redirect: 'error',
  });
  const text = await res.text();
  return { json: text ? JSON.parse(text) : null, status: res.status, text };
}

/** Push the fixture to the repository's default branch unless it already carries it. */
async function seedFixture(env, owner, repo) {
  const probe = await gh(env, 'GET', `/repos/${owner}/${repo}/contents/package.json`);
  if (probe.status === 200) {
    return 'present';
  }
  if (probe.status !== 404) {
    throw new Error(`reading the fixture repository failed: HTTP ${probe.status}`);
  }
  for (const file of fixtureFiles()) {
    const put = await gh(env, 'PUT', `/repos/${owner}/${repo}/contents/${file.path}`, {
      content: file.content.toString('base64'),
      message: `chore: seed live end-to-end fixture (${file.path})`,
    });
    if (![200, 201].includes(put.status)) {
      throw new Error(`seeding ${file.path} failed: HTTP ${put.status} ${put.text.slice(0, 200)}`);
    }
  }
  return 'seeded';
}

async function bootstrap(env) {
  const missing = missingEnv(env);
  if (missing.length > 0) {
    throw new Error(`missing ${missing.map((n) => `${n} (${REQUIRED_ENV[n]})`).join(', ')}`);
  }
  const base = (env.LIVE_E2E_API_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const { owner, repo } = parseRepoSlug(env.LIVE_E2E_FIXTURE_REPO);
  const seeded = await seedFixture(env, owner, repo);
  console.error(`fixture repository: ${seeded}`);
  const cookie = await signIn(base, env);
  await storeCredential(base, cookie, 'anthropic', env.ANTHROPIC_API_KEY);
  await storeCredential(base, cookie, 'openai', env.OPENAI_API_KEY);
  await enableMcp(base, cookie);
  const repoId = await ensureConnection(base, cookie, owner, repo, env);
  const token = await issueToken(base, cookie);
  return { LIVE_E2E_API_URL: base, LIVE_E2E_REPO_ID: repoId, LIVE_E2E_TOKEN: token };
}

async function main() {
  const command = process.argv[2];
  if (command !== 'bootstrap') {
    console.error('usage: node scripts/live-e2e-stack.mjs bootstrap');
    process.exit(2);
  }
  const values = await bootstrap(process.env);
  const githubEnv = process.env.GITHUB_ENV;
  for (const line of envLines(values)) {
    if (line.mask !== undefined) {
      console.log(`::add-mask::${line.mask}`);
    } else if (githubEnv) {
      appendFileSync(githubEnv, `${line.env}\n`);
    } else {
      console.log(line.env);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(`live-e2e-stack: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
