import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DOCKER_HOST_ALIAS } from '@auto-swe/shared/lib/systemConfig';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockerWorkspaceBackend, ephemeralArgs } from './docker.js';

describe('ephemeralArgs', () => {
  it('runs with no network unless the spec asks for egress', () => {
    expect(ephemeralArgs({ image: 'img' }, false)).toContain('--network=none');
    expect(ephemeralArgs({ image: 'img', network: 'none' }, false)).toContain('--network=none');
    expect(ephemeralArgs({ image: 'img', network: 'egress' }, false)).toContain('--network=bridge');
  });

  it('maps reachWorker to the host-gateway alias, after the resolved hosts', () => {
    const args = ephemeralArgs(
      { addHosts: ['example.com:203.0.113.7'], image: 'img', reachWorker: true },
      false
    );
    const hosts = args.filter((a) => a.startsWith('--add-host='));
    expect(hosts).toEqual([
      '--add-host=example.com:203.0.113.7',
      `--add-host=${DOCKER_HOST_ALIAS}:host-gateway`,
    ]);
  });

  it('adds no worker alias when the container does not need the worker', () => {
    const args = ephemeralArgs({ image: 'img' }, false);
    expect(args.some((a) => a.startsWith('--add-host='))).toBe(false);
  });
});

describe('canReachWorkerProxy', () => {
  it('accepts only a proxy advertised at the Docker host alias', () => {
    const backend = dockerWorkspaceBackend();
    expect(backend.canReachWorkerProxy(`http://${DOCKER_HOST_ALIAS}:9000`)).toBe(true);
    expect(backend.canReachWorkerProxy('http://worker.internal:9000')).toBe(false);
  });
});

describe('secretEnv', () => {
  // A stand-in `docker` first on PATH: records its argv and the value of the
  // secret variable it was handed in its environment.
  const FAKE = `#!/usr/bin/env node
require('node:fs').appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({ args: process.argv.slice(2), secret: process.env.ASW_GIT_AUTH ?? null }) + '\\n'
);
`;
  const HEADER = 'AUTHORIZATION: basic c2VjcmV0LXRva2Vu';
  let dir: string;
  let oldPath: string | undefined;
  const calls = async (): Promise<{ args: string[]; secret: string | null }[]> =>
    (await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-secret-'));
    await fs.writeFile(path.join(dir, 'docker'), FAKE, { mode: 0o755 });
    process.env.FAKE_LOG = path.join(dir, 'log.jsonl');
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    delete process.env.ASW_GIT_AUTH;
  });
  afterEach(async () => {
    process.env.PATH = oldPath;
    delete process.env.FAKE_LOG;
    await fs.rm(dir, { force: true, recursive: true });
  });

  const backend = dockerWorkspaceBackend();

  it('exec names the variable and hands the value over in the client environment', async () => {
    await backend.exec(backend.attach('workspace-t1'), ['sh', '-c', 'true'], {
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: HEADER },
    });
    const [call] = await calls();
    expect(call?.args).toEqual(expect.arrayContaining(['-e', 'ASW_GIT_AUTH']));
    expect(JSON.stringify(call?.args)).not.toContain('c2VjcmV0LXRva2Vu');
    expect(call?.secret).toBe(HEADER);
    expect(process.env.ASW_GIT_AUTH).toBeUndefined();
  });

  it('exec with stdin does the same', async () => {
    await backend.exec(backend.attach('workspace-t1'), ['cat'], {
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: HEADER },
      stdin: 'payload',
    });
    const [call] = await calls();
    expect(call?.args).toEqual(expect.arrayContaining(['-i', '-e', 'ASW_GIT_AUTH']));
    expect(JSON.stringify(call?.args)).not.toContain('c2VjcmV0LXRva2Vu');
    expect(call?.secret).toBe(HEADER);
  });

  it('execShell does the same through the shell string', async () => {
    await backend.execShell(backend.attach('workspace-t1'), ['sh', '-c', 'true'], {
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: HEADER },
    });
    const [call] = await calls();
    expect(call?.args).toEqual(expect.arrayContaining(['-e', 'ASW_GIT_AUTH']));
    expect(JSON.stringify(call?.args)).not.toContain('c2VjcmV0LXRva2Vu');
    expect(call?.secret).toBe(HEADER);
  });

  it('runHelper does the same', async () => {
    await backend.runHelper(
      {
        argv: ['-c', 'true'],
        entrypoint: 'sh',
        image: 'helper:1',
        secretEnv: { ASW_GIT_AUTH: HEADER },
      },
      { heartbeatLabel: 't' }
    );
    const [call] = await calls();
    expect(call?.args).toEqual(expect.arrayContaining(['-e', 'ASW_GIT_AUTH']));
    expect(JSON.stringify(call?.args)).not.toContain('c2VjcmV0LXRva2Vu');
    expect(call?.secret).toBe(HEADER);
  });

  it('refuses a secret name that is not a plain identifier, before docker runs', async () => {
    const h = backend.attach('workspace-t1');
    const opts = (name: string) => ({ heartbeatLabel: 't', secretEnv: { [name]: 'v' } });
    for (const name of ['A; id', 'A=b', '1A', '']) {
      await expect(backend.execShell(h, ['sh', '-c', 'true'], opts(name))).rejects.toThrow(
        /invalid secret environment name/
      );
      await expect(backend.exec(h, ['true'], opts(name))).rejects.toThrow(
        /invalid secret environment name/
      );
    }
    expect(() =>
      backend.spawn(h, ['true'], { secretEnv: { 'A=b': 'v' }, stdio: ['ignore', 'pipe', 'pipe'] })
    ).toThrow(/invalid secret environment name/);
    await expect(
      backend.runHelper({ image: 'helper:1', secretEnv: { 'A=b': 'v' } }, { heartbeatLabel: 't' })
    ).rejects.toThrow(/invalid secret environment name/);
    await expect(fs.access(path.join(dir, 'log.jsonl'))).rejects.toThrow();
  });
});

describe('ephemeral containers with secretEnv', () => {
  // A stand-in `docker`: records argv and the token variable it was handed.
  const FAKE = `#!/usr/bin/env node
require('node:fs').appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({
    args: process.argv.slice(2),
    token: process.env.YARN_NPM_AUTH_TOKEN ?? null,
  }) + '\\n'
);
`;
  const TOKEN = 'proxy-tok-s3cret';
  let dir: string;
  let oldPath: string | undefined;
  const calls = async (): Promise<{ args: string[]; token: string | null }[]> =>
    (await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const spec = {
    env: ['PLAIN=1'],
    image: 'img:1',
    name: 'shellstep-t1',
    secretEnv: { YARN_NPM_AUTH_TOKEN: TOKEN },
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-ephemeral-'));
    await fs.writeFile(path.join(dir, 'docker'), FAKE, { mode: 0o755 });
    process.env.FAKE_LOG = path.join(dir, 'log.jsonl');
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    delete process.env.YARN_NPM_AUTH_TOKEN;
  });
  afterEach(async () => {
    process.env.PATH = oldPath;
    delete process.env.FAKE_LOG;
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('ephemeralArgs names a secret without its value', () => {
    for (const detached of [false, true]) {
      const args = ephemeralArgs(spec, detached);
      expect(args).toEqual(expect.arrayContaining(['-e', 'YARN_NPM_AUTH_TOKEN', 'PLAIN=1']));
      expect(JSON.stringify(args)).not.toContain(TOKEN);
      // Before the `--` that ends the options, like every other flag.
      expect(args.indexOf('YARN_NPM_AUTH_TOKEN')).toBeLessThan(args.indexOf('--'));
    }
  });

  it('ephemeralArgs refuses a secret name that is not a plain identifier', () => {
    expect(() => ephemeralArgs({ image: 'img:1', secretEnv: { 'A=b': 'v' } }, false)).toThrow(
      /invalid secret environment name/
    );
  });

  it('runEphemeral hands the value over in the client environment only', async () => {
    await dockerWorkspaceBackend().runEphemeral(spec, { heartbeatLabel: 't' });
    const [run] = await calls();
    expect(run?.args).toEqual(expect.arrayContaining(['-e', 'YARN_NPM_AUTH_TOKEN']));
    expect(JSON.stringify(run?.args)).not.toContain(TOKEN);
    expect(run?.token).toBe(TOKEN);
    expect(process.env.YARN_NPM_AUTH_TOKEN).toBeUndefined();
  });

  it('startDetached does the same', async () => {
    await dockerWorkspaceBackend().startDetached(spec, { heartbeatLabel: 't' });
    const [run] = await calls();
    expect(run?.args).toEqual(expect.arrayContaining(['-d', '-e', 'YARN_NPM_AUTH_TOKEN']));
    expect(JSON.stringify(run?.args)).not.toContain(TOKEN);
    expect(run?.token).toBe(TOKEN);
  });
});

describe('create with secretEnv', () => {
  // A stand-in `docker`: records argv and the token variable it was handed, and
  // answers the keeper probe so `create` completes.
  const FAKE = `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({ args, token: process.env.YARN_NPM_AUTH_TOKEN ?? null }) + '\\n'
);
if (args[0] === 'exec') process.stdout.write('42\\n');
`;
  const TOKEN = 'proxy-tok-s3cret';
  let dir: string;
  let oldPath: string | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docker-create-'));
    await fs.writeFile(path.join(dir, 'docker'), FAKE, { mode: 0o755 });
    process.env.FAKE_LOG = path.join(dir, 'log.jsonl');
    oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
    delete process.env.YARN_NPM_AUTH_TOKEN;
  });
  afterEach(async () => {
    process.env.PATH = oldPath;
    delete process.env.FAKE_LOG;
    await fs.rm(dir, { force: true, recursive: true });
  });

  it('names the variable on docker run and hands the value over in the environment', async () => {
    await dockerWorkspaceBackend().create({
      cpus: 1,
      dns: [],
      env: ['PLAIN=1'],
      image: 'img:1',
      memory: '1g',
      name: 'workspace-t1',
      pidsLimit: 10,
      reachWorker: false,
      secretEnv: { YARN_NPM_AUTH_TOKEN: TOKEN },
    });
    const lines = (await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8')).split('\n');
    const calls: { args: string[]; token: string | null }[] = lines
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const run = calls.find((c) => c.args[0] === 'run');
    expect(run?.args).toEqual(expect.arrayContaining(['-e', 'YARN_NPM_AUTH_TOKEN', 'PLAIN=1']));
    expect(JSON.stringify(calls.map((c) => c.args))).not.toContain(TOKEN);
    expect(run?.token).toBe(TOKEN);
  });
});
