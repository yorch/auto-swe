import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkEnv,
  formatValue,
  main,
  maskEnv,
  parseEnv,
  parseValues,
  planValues,
  renderEnv,
  SECRETS,
  unifiedDiff,
} from './env-setup.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_TEMPLATE = readFileSync(resolve(HERE, '..', '.env.example'), 'utf8');

const TEMPLATE = `# header
POSTGRES_USER=postgres
POSTGRES_PASSWORD=password
POSTGRES_DB=app
DATABASE_URL=postgresql://postgres:password@localhost:5432/app
COMPOSE_PROFILES=objectstore

# secrets
CONFIG_ENCRYPTION_KEY=
BETTER_AUTH_SECRET=
JWT_SECRET=
SEED_ADMIN_PASSWORD=

# DEFAULT_TEAM_SLUG=default   # note
# OPTIONAL=1
# GARAGE_RPC_SECRET=
# second mention
# DEFAULT_TEAM_SLUG=default
`;

let dir;
let out;
let io;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'env-setup-'));
  out = [];
  io = { err: (s) => out.push(s), isTTY: false, out: (s) => out.push(s) };
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

const run = (args, extra = {}) =>
  main(['--template', join(dir, 'tpl'), '--file', join(dir, '.env'), ...args], {
    ...io,
    ...extra,
  });
const read = () => readFileSync(join(dir, '.env'), 'utf8');
const seedTemplate = (t = TEMPLATE) => writeFileSync(join(dir, 'tpl'), t);
const domains = ['--set', 'DOMAIN_API=api.x.io', '--set', 'DOMAIN_APP=app.x.io'];

describe('parseEnv', () => {
  it('reads plain, quoted, multi-line and inline-comment values', () => {
    const v = parseValues(
      [
        'A=plain',
        'B="quoted # not a comment"  # trailing',
        "C='single $x'",
        'D=bare # comment',
        'PEM="-----BEGIN-----',
        'line2',
        '-----END-----"',
        'E=after',
        'F="a\\nb"',
        'export G=1',
        '# H=commented',
      ].join('\n')
    );
    expect(v.get('A')).toBe('plain');
    expect(v.get('B')).toBe('quoted # not a comment');
    expect(v.get('C')).toBe('single $x');
    expect(v.get('D')).toBe('bare');
    expect(v.get('PEM')).toBe('-----BEGIN-----\nline2\n-----END-----');
    expect(v.get('E')).toBe('after');
    expect(v.get('F')).toBe('a\nb');
    expect(v.get('G')).toBe('1');
    expect(v.has('H')).toBe(false);
  });

  it('classifies commented keys but not prose or indented examples', () => {
    const items = parseEnv('# KEY=1\n# prose KEY=1\n#   INDENTED=1\n# a: B=2');
    expect(items.map((i) => i.type)).toEqual(['commented', 'text', 'text', 'text']);
  });

  it('formats values so they read back unchanged', () => {
    for (const v of ['abc+/=', 'has space', 'a#b', "it's", 'x$y', 'multi\nline']) {
      expect(parseValues(`K=${formatValue(v)}`).get('K')).toBe(v);
    }
  });
});

describe('init', () => {
  it('generates valid secrets and a consistent DATABASE_URL', async () => {
    seedTemplate();
    expect(await run(['init', '--yes'])).toBe(0);
    const v = parseValues(read());
    expect(Buffer.from(v.get('CONFIG_ENCRYPTION_KEY'), 'base64')).toHaveLength(32);
    expect(v.get('BETTER_AUTH_SECRET').length).toBeGreaterThanOrEqual(32);
    expect(v.get('JWT_SECRET').length).toBeGreaterThanOrEqual(32);
    expect(v.get('SEED_ADMIN_PASSWORD')).toBeTruthy();
    expect(v.get('GARAGE_RPC_SECRET')).toMatch(/^[0-9a-f]{64}$/);
    expect(checkEnv(v).errors).toEqual([]);
    expect((statSync(join(dir, '.env')).mode & 0o777).toString(8)).toBe('600');
  });

  it('refuses when the target exists', async () => {
    seedTemplate();
    writeFileSync(join(dir, '.env'), 'X=1\n');
    expect(await run(['init', '--yes'])).toBe(1);
    expect(read()).toBe('X=1\n');
  });

  it('omits GARAGE_RPC_SECRET when objectstore is off', async () => {
    seedTemplate();
    expect(await run(['init', '--yes', '--set', 'COMPOSE_PROFILES='])).toBe(0);
    expect(parseValues(read()).has('GARAGE_RPC_SECRET')).toBe(false);
  });

  it('prod profile generates a URL-safe password and S3 keys, and rebuilds DATABASE_URL', async () => {
    seedTemplate();
    expect(await run(['init', '--yes', '--profile', 'prod', ...domains])).toBe(0);
    const v = parseValues(read());
    expect(v.get('POSTGRES_PASSWORD')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(v.get('DATABASE_URL')).toContain(`:${v.get('POSTGRES_PASSWORD')}@localhost:5432/app`);
    expect(v.get('ARTIFACT_S3_SECRET_KEY').length).toBeGreaterThanOrEqual(16);
    expect(v.get('NODE_ENV')).toBe('production');
    expect(v.get('PUBLIC_URL')).toBe('https://api.x.io');
    expect(v.get('CORS_ORIGIN')).toBe('https://app.x.io');
    expect(checkEnv(v, { profile: 'prod' }).errors).toEqual([]);
  });

  it('encodes a --set password into DATABASE_URL', async () => {
    seedTemplate();
    await run(['init', '--yes', '--set', 'POSTGRES_PASSWORD=p@ss/w:rd']);
    const v = parseValues(read());
    expect(v.get('DATABASE_URL')).toContain('p%40ss%2Fw%3Ard');
    expect(checkEnv(v).errors).toEqual([]);
  });

  it('prompts on a TTY, accepts Enter, lets --set win, and never asks for a secret', async () => {
    seedTemplate(`${TEMPLATE}# SEED_ADMIN_EMAIL=admin@auto-swe.local\n`);
    const asked = [];
    await run(['init'], {
      ask: async (q) => {
        asked.push(q);
        return 'me@x.io';
      },
      isTTY: true,
    });
    expect(parseValues(read()).get('SEED_ADMIN_EMAIL')).toBe('me@x.io');
    rmSync(join(dir, '.env'));
    await run(['init', '--set', 'SEED_ADMIN_EMAIL=set@x.io'], {
      ask: async () => 'me@x.io',
      isTTY: true,
    });
    expect(parseValues(read()).get('SEED_ADMIN_EMAIL')).toBe('set@x.io');
    rmSync(join(dir, '.env'));
    await run(['init'], { ask: async () => '', isTTY: true });
    expect(parseValues(read()).has('SEED_ADMIN_EMAIL')).toBe(false);
    expect(asked.some((q) => /SECRET|PASSWORD|KEY/.test(q))).toBe(false);
  });
});

describe('sync', () => {
  const withKey = () =>
    TEMPLATE.replace(
      'CONFIG_ENCRYPTION_KEY=',
      `CONFIG_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`
    );

  it('carries values, uncomments template-commented keys once, keeps later duplicates commented', async () => {
    seedTemplate();
    writeFileSync(
      join(dir, '.env'),
      'POSTGRES_USER=bob\nDEFAULT_TEAM_SLUG=payments\n# OPTIONAL=1\nBETTER_AUTH_SECRET=keep-me-keep-me-keep-me-keep-me-12\n'
    );
    expect(await run(['sync', '--yes'])).toBe(0);
    const text = read();
    const v = parseValues(text);
    expect(v.get('POSTGRES_USER')).toBe('bob');
    expect(v.get('DEFAULT_TEAM_SLUG')).toBe('payments');
    expect(text.match(/^DEFAULT_TEAM_SLUG=/gm)).toHaveLength(1);
    expect(text).toContain('# DEFAULT_TEAM_SLUG=default\n');
    expect(text.indexOf('DEFAULT_TEAM_SLUG=payments')).toBeLessThan(
      text.indexOf('# second mention')
    );
    expect(v.has('OPTIONAL')).toBe(false);
    expect(v.get('BETTER_AUTH_SECRET')).toBe('keep-me-keep-me-keep-me-keep-me-12');
    expect(v.get('JWT_SECRET')).toBeTruthy();
    expect(out.join('\n')).toMatch(/generated: .*JWT_SECRET/);
  });

  it('never regenerates or overwrites an existing secret', async () => {
    seedTemplate();
    const key = randomBytes(32).toString('base64');
    writeFileSync(
      join(dir, '.env'),
      `CONFIG_ENCRYPTION_KEY=${key}\nBETTER_AUTH_SECRET=a\nJWT_SECRET=b\nSEED_ADMIN_PASSWORD=c\nGARAGE_RPC_SECRET=d\n`
    );
    await run(['sync', '--yes']);
    const v = parseValues(read());
    expect(v.get('CONFIG_ENCRYPTION_KEY')).toBe(key);
    expect([v.get('BETTER_AUTH_SECRET'), v.get('JWT_SECRET'), v.get('GARAGE_RPC_SECRET')]).toEqual([
      'a',
      'b',
      'd',
    ]);
    const other = randomBytes(32).toString('base64');
    expect(await run(['sync', '--yes', '--set', `CONFIG_ENCRYPTION_KEY=${other}`])).toBe(1);
    expect(parseValues(read()).get('CONFIG_ENCRYPTION_KEY')).toBe(key);

    const base = new Map(Object.keys(SECRETS).map((k) => [k, 'x']));
    base.set('COMPOSE_PROFILES', 'objectstore');
    const plan = planValues(base, {
      mode: 'sync',
      profile: 'local',
      rand: randomBytes,
      sets: new Map(),
    });
    expect(plan.generated).toEqual([]);
  });

  it('preserves local additions and multi-line values', async () => {
    seedTemplate();
    writeFileSync(
      join(dir, '.env'),
      `${withKey()}MY_THING=1\nMY_PEM="-----BEGIN\nabc\n-----END"\n`
    );
    await run(['sync', '--yes']);
    const text = read();
    expect(text).toContain(
      '# ── Local additions (not in .env.example) ──\nMY_THING=1\nMY_PEM="-----BEGIN\nabc\n-----END"\n'
    );
    expect(parseValues(text).get('MY_PEM')).toBe('-----BEGIN\nabc\n-----END');
  });

  it('is idempotent', async () => {
    seedTemplate();
    writeFileSync(join(dir, '.env'), `${withKey()}MY_THING=1\nDEFAULT_TEAM_SLUG=x # why\n`);
    await run(['sync', '--yes']);
    const once = read();
    await run(['sync', '--yes']);
    expect(read()).toBe(once);
    expect(readdirSync(dir).filter((f) => f.startsWith('.env.bak-'))).toHaveLength(1);
  });

  it('migrates renamed keys', () => {
    const { text, report } = renderEnv('# NEW_NAME=\nOTHER=1\n', 'OLD_NAME=hello\n', new Map(), {
      OLD_NAME: 'NEW_NAME',
    });
    expect(text).toBe('NEW_NAME=hello\nOTHER=1\n');
    expect(report.renamed).toEqual(['OLD_NAME -> NEW_NAME']);
    expect(text).not.toContain('Local additions');
  });

  it('backs up with a timestamp and fails when the target is missing', async () => {
    seedTemplate();
    expect(await run(['sync', '--yes'])).toBe(1);
    writeFileSync(join(dir, '.env'), 'POSTGRES_USER=z\n');
    await run(['sync', '--yes'], { now: new Date('2026-01-02T03:04:05.000Z') });
    expect(readdirSync(dir)).toContain('.env.bak-2026-01-02T03-04-05-000Z');
  });
});

describe('dry-run', () => {
  it('writes nothing and masks secret values', async () => {
    seedTemplate();
    writeFileSync(
      join(dir, '.env'),
      'GITHUB_TOKEN=ghp_supersecrettoken\nPOSTGRES_PASSWORD=hunter2hunter2\n'
    );
    expect(await run(['sync', '--yes', '--dry-run'])).toBe(0);
    const shown = out.join('\n');
    expect(shown).not.toMatch(/ghp_supersecrettoken|hunter2/);
    expect(shown).toMatch(/\+JWT_SECRET=\*\*\*\*/);
    expect(read()).toContain('ghp_supersecrettoken');
    expect(readdirSync(dir).some((f) => f.includes('.bak-'))).toBe(false);
    rmSync(join(dir, '.env'));
    await run(['init', '--yes', '--dry-run']);
    expect(readdirSync(dir)).not.toContain('.env');
  });

  it('masks passwords embedded in URLs and diffs lines', () => {
    expect(maskEnv('DATABASE_URL=postgresql://u:pw@h/db\nA=1')).toBe('DATABASE_URL=****\nA=1');
    expect(unifiedDiff('a\nb\nc', 'a\nB\nc')).toBe(' a\n-b\n+B\n c');
  });
});

describe('check', () => {
  const good = () =>
    new Map(
      Object.entries({
        BETTER_AUTH_SECRET: 'x'.repeat(40),
        COMPOSE_PROFILES: 'objectstore',
        CONFIG_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
        GARAGE_RPC_SECRET: 'a'.repeat(64),
        JWT_SECRET: 'y'.repeat(40),
        POSTGRES_DB: 'd',
        POSTGRES_PASSWORD: 'p',
        POSTGRES_USER: 'u',
        SEED_ADMIN_PASSWORD: 'longenough',
      })
    );
  const errorsWith = (patch, opts) => {
    const v = good();
    for (const [k, val] of Object.entries(patch)) {
      if (val === null) {
        v.delete(k);
      } else {
        v.set(k, val);
      }
    }
    return checkEnv(v, opts).errors.join('\n');
  };

  it('passes a good file', () => {
    expect(checkEnv(good()).errors).toEqual([]);
  });
  it('flags an empty required key', () => {
    expect(errorsWith({ JWT_SECRET: '' })).toMatch(/JWT_SECRET/);
  });
  it('accepts an RS256 key pair instead of JWT_SECRET', () => {
    expect(
      errorsWith({ JWT_PRIVATE_KEY_PATH: '/a', JWT_PUBLIC_KEY_PATH: '/b', JWT_SECRET: '' })
    ).toBe('');
  });
  it('flags a CONFIG_ENCRYPTION_KEY of the wrong size', () => {
    expect(errorsWith({ CONFIG_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toMatch(
      /32 bytes/
    );
    expect(errorsWith({ CONFIG_ENCRYPTION_KEY: 'not base64!' })).toMatch(/32 bytes/);
  });
  it('flags short auth secrets', () => {
    expect(errorsWith({ BETTER_AUTH_SECRET: 'short' })).toMatch(/BETTER_AUTH_SECRET/);
    expect(errorsWith({ JWT_SECRET: 'short' })).toMatch(/JWT_SECRET/);
  });
  it('flags a DATABASE_URL that disagrees with POSTGRES_*', () => {
    expect(errorsWith({ DATABASE_URL: 'postgresql://u:other@h:5432/d' })).toMatch(/DATABASE_URL/);
    expect(errorsWith({ POSTGRES_DB: 'zzz' })).toMatch(/DATABASE_URL/);
  });
  it('requires GARAGE_RPC_SECRET under the objectstore profile only', () => {
    expect(errorsWith({ GARAGE_RPC_SECRET: null })).toMatch(/GARAGE_RPC_SECRET/);
    expect(errorsWith({ COMPOSE_PROFILES: '', GARAGE_RPC_SECRET: null })).toBe('');
    expect(errorsWith({ GARAGE_RPC_SECRET: 'abc' })).toMatch(/64 hex/);
  });
  it('flags a short S3 secret when set', () => {
    expect(errorsWith({ ARTIFACT_S3_SECRET_KEY: 'short' })).toMatch(/ARTIFACT_S3_SECRET_KEY/);
  });

  describe('prod', () => {
    const prodOk = {
      ARTIFACT_S3_ACCESS_KEY: 'GK0123456789abcdef',
      ARTIFACT_S3_SECRET_KEY: 'z'.repeat(32),
      BETTER_AUTH_URL: 'https://api.x.io',
      CORS_ORIGIN: 'https://app.x.io',
      NEXT_PUBLIC_API_URL: 'https://api.x.io',
      PUBLIC_URL: 'https://api.x.io',
      WEB_URL: 'https://app.x.io',
    };
    const prod = { profile: 'prod' };
    it('passes with real URLs', () => {
      expect(errorsWith(prodOk, prod)).toBe('');
    });
    it('fails on localhost and unset public URLs', () => {
      expect(errorsWith({ ...prodOk, PUBLIC_URL: 'http://localhost:8080' }, prod)).toMatch(
        /PUBLIC_URL points at localhost/
      );
      expect(errorsWith({ ...prodOk, CORS_ORIGIN: 'http://127.0.0.1:3000' }, prod)).toMatch(
        /CORS_ORIGIN/
      );
      expect(errorsWith({ ...prodOk, WEB_URL: null }, prod)).toMatch(/WEB_URL is unset/);
    });
    it('fails on dev defaults', () => {
      expect(
        errorsWith({ ...prodOk, ARTIFACT_S3_SECRET_KEY: 'autoswelocaldevsecret' }, prod)
      ).toMatch(/dev default/);
      expect(
        errorsWith(
          { ...prodOk, DATABASE_URL: 'postgresql://u:password@h/d', POSTGRES_PASSWORD: 'password' },
          prod
        )
      ).toMatch(/POSTGRES_PASSWORD is still the dev default/);
    });
    it('is not applied to the local profile', () => {
      expect(errorsWith({})).toBe('');
    });
  });

  it('warns, not fails, on template keys missing from the file', () => {
    const r = checkEnv(good(), { templateKeys: ['TEMPORAL_NAMESPACE'] });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join()).toMatch(/TEMPORAL_NAMESPACE/);
  });

  it('exits non-zero from the CLI and never prints values', async () => {
    seedTemplate();
    writeFileSync(join(dir, '.env'), 'JWT_SECRET=topsecretvalue\nCONFIG_ENCRYPTION_KEY=\n');
    expect(await run(['check'])).toBe(1);
    expect(out.join('\n')).not.toContain('topsecretvalue');
  });
});

describe('the real .env.example', () => {
  it('has a generator for every empty active key', () => {
    const empty = parseEnv(REAL_TEMPLATE)
      .filter((i) => i.type === 'kv' && i.value === '')
      .map((i) => i.key);
    expect(empty.length).toBeGreaterThan(0);
    for (const key of empty) {
      expect(SECRETS[key]?.generate, `${key} needs an entry in SECRETS`).toBeTypeOf('function');
    }
  });

  it('renders into a file that passes check, and re-syncs to itself', async () => {
    writeFileSync(join(dir, 'tpl'), REAL_TEMPLATE);
    expect(await run(['init', '--yes'])).toBe(0);
    const text = read();
    expect(checkEnv(parseValues(text)).errors).toEqual([]);
    await run(['sync', '--yes']);
    expect(read()).toBe(text);
    const keys = (t) =>
      parseEnv(t)
        .filter((i) => i.key)
        .map((i) => i.key);
    expect(keys(text)).toEqual(keys(REAL_TEMPLATE));
  });

  it('a prod init passes `check --profile prod` once domains are given', async () => {
    writeFileSync(join(dir, 'tpl'), REAL_TEMPLATE);
    await run(['init', '--yes', '--profile', 'prod', ...domains]);
    expect(await run(['check', '--profile', 'prod'])).toBe(0);
  });
});

describe('end to end', () => {
  it('runs as a script', () => {
    writeFileSync(join(dir, 'tpl'), REAL_TEMPLATE);
    const script = join(HERE, 'env-setup.mjs');
    const args = ['--template', join(dir, 'tpl'), '--file', join(dir, '.env')];
    execFileSync('node', [script, 'init', '--yes', ...args], { stdio: 'pipe' });
    execFileSync('node', [script, 'check', ...args], { stdio: 'pipe' });
    const shown = execFileSync('node', [script, 'sync', '--dry-run', ...args], {
      encoding: 'utf8',
    });
    expect(shown).toContain('(no changes)');
    expect(shown).not.toContain(parseValues(read()).get('CONFIG_ENCRYPTION_KEY'));
  });
});
