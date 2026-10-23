import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

import {
  type GitIdentity,
  gitIdentityConfigScript,
  withCoAuthorTrailer,
} from '../lib/gitIdentity.js';
import { commitStaged } from './allowedPaths.js';
import type { Workspace } from './workspace.js';

/**
 * Real commits under every launcher-attribution mode, read back with `git log`.
 * The same assertions run twice: against the host's git (always, in a temp dir
 * with its own global config) and against the executor image's git in a Docker
 * container (opt in with GIT_IDENTITY_DOCKER_TEST=1; needs a Docker daemon and
 * network for `apk add git`). The container run is what shows the
 * `author.*`/`committer.*` config keys work on the image's git.
 */
const enabled = process.env.GIT_IDENTITY_DOCKER_TEST === '1';
const suffix = Math.random().toString(16).slice(2, 8);
const CONTAINER = `git-identity-it-${suffix}`;

/** Runs a shell command in `dir`, with a global git config of its own. */
type Runner = (dir: string, cmd: string) => string;

const BOT = { email: 'bot@example.com', name: 'Acme Bot' };
const LAUNCHER = { email: 'ada@example.com', name: 'Ada Lovelace' };
const HOSTILE_BOT = { email: 'bot@example.com', name: "Acme 'Bot'; touch pwned" };
const DASH_LAUNCHER = { email: 'dash@example.com', name: '-Dash; touch pwned' };
const TRAILER = (who: { name: string; email: string }) =>
  `Co-authored-by: ${who.name} <${who.email}>`;

interface Case {
  title: string;
  identity: GitIdentity;
  expected: { an: string; ae: string; cn: string; ce: string; trailer?: string };
}

const CASES: Case[] = [
  {
    expected: { ae: BOT.email, an: BOT.name, ce: BOT.email, cn: BOT.name },
    identity: { author: BOT, committer: BOT },
    title: 'none: author and committer are the configured identity, no trailer',
  },
  {
    expected: {
      ae: BOT.email,
      an: BOT.name,
      ce: BOT.email,
      cn: BOT.name,
      trailer: TRAILER(LAUNCHER),
    },
    identity: { author: BOT, coAuthorTrailer: TRAILER(LAUNCHER), committer: BOT },
    title: 'co-author-trailer: configured identity plus a trailing Co-authored-by',
  },
  {
    expected: { ae: LAUNCHER.email, an: LAUNCHER.name, ce: BOT.email, cn: BOT.name },
    identity: { author: LAUNCHER, committer: BOT },
    title: 'author: the launcher authors, the configured identity commits',
  },
  {
    expected: {
      ae: DASH_LAUNCHER.email,
      an: DASH_LAUNCHER.name,
      ce: HOSTILE_BOT.email,
      cn: HOSTILE_BOT.name,
    },
    identity: { author: DASH_LAUNCHER, committer: HOSTILE_BOT },
    title: 'hostile names are recorded exactly and run nothing',
  },
];

function readBack(run: Runner, dir: string) {
  const out = run(dir, 'git log -1 --format=%an%n%ae%n%cn%n%ce%n%B').replace(/\n+$/, '');
  const [an, ae, cn, ce, ...message] = out.split('\n');
  return { ae, an, ce, cn, message: message.join('\n') };
}

function defineAttributionTests(
  run: Runner,
  newDir: () => string,
  escaped: (dir: string) => boolean
) {
  const workspaceFor = (dir: string, identity: GitIdentity) =>
    ({ exec: async (cmd: string) => run(dir, cmd), gitIdentity: identity }) as unknown as Workspace;

  const stage = (dir: string) => {
    run(dir, 'git init -q . && echo hello > file.txt && git add -A');
  };

  for (const { title, identity, expected } of CASES) {
    const message = expected.trailer ? `auto: it\n\n${expected.trailer}` : 'auto: it';

    it(`global config path, ${title}`, async () => {
      const dir = newDir();
      stage(dir);
      run(dir, gitIdentityConfigScript(identity));
      await commitStaged(workspaceFor(dir, identity), 'auto: it', undefined);
      expect(readBack(run, dir)).toEqual({
        ae: expected.ae,
        an: expected.an,
        ce: expected.ce,
        cn: expected.cn,
        message,
      });
      expect(withCoAuthorTrailer('auto: it', identity)).toBe(message);
      expect(escaped(dir)).toBe(false);
    });

    it(`guarded commit (global config ignored), ${title}`, async () => {
      const dir = newDir();
      stage(dir);
      // A global identity that must not leak into the guarded commit.
      run(dir, 'git config --global user.name Leak && git config --global user.email leak@x');
      const sessionBase = '0'.repeat(40);
      const sha = await commitStaged(workspaceFor(dir, identity), 'auto: it', {
        allowedPaths: undefined,
        refuseWorkflowChanges: false,
        report: { sha: '', twoTree: false },
        sessionBase,
      });
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      expect(readBack(run, dir)).toEqual({
        ae: expected.ae,
        an: expected.an,
        ce: expected.ce,
        cn: expected.cn,
        message,
      });
      expect(escaped(dir)).toBe(false);
    });
  }
}

describe('git attribution modes against host git', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-identity-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: home,
  };
  let n = 0;
  const run: Runner = (dir, cmd) =>
    execFileSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', env, stdio: 'pipe' });
  const newDir = () => {
    const dir = join(root, `repo-${n++}`);
    mkdirSync(dir);
    writeFileSync(join(home, '.gitconfig'), '');
    return dir;
  };
  afterAll(() => rmSync(root, { force: true, recursive: true }));

  defineAttributionTests(
    run,
    newDir,
    (dir) => existsSync(join(dir, 'pwned')) || existsSync(join(home, 'pwned'))
  );
});

describe.skipIf(!enabled)('git attribution modes in the executor image', () => {
  let n = 0;
  const dexec = (dir: string, cmd: string) =>
    execFileSync('docker', ['exec', '-w', dir, CONTAINER, 'sh', '-c', cmd], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  const run: Runner = (dir, cmd) => dexec(dir, cmd);
  const newDir = () => {
    const dir = `/workspace/repo-${n++}`;
    dexec('/', `mkdir -p ${dir} && rm -f /root/.gitconfig`);
    return dir;
  };

  beforeAll(() => {
    execFileSync('docker', ['run', '-d', '--name', CONTAINER, 'alpine:3.22', 'sleep', 'infinity']);
    dexec('/', 'apk add --no-cache git >/dev/null');
  }, 300_000);

  afterAll(() => {
    try {
      execFileSync('docker', ['rm', '-f', CONTAINER]);
    } catch {
      /* gone */
    }
  });

  defineAttributionTests(run, newDir, (dir) => {
    try {
      dexec('/', `test -e ${dir}/pwned -o -e /root/pwned -o -e /pwned`);
      return true;
    } catch {
      return false;
    }
  });
});
