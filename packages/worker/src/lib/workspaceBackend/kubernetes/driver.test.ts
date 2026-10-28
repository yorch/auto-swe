import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KubernetesWorkspaceConfig } from '@auto-swe/shared/lib/systemConfig';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceContainerSpec } from '../types.js';
import { KubernetesWorkspaceBackend } from './driver.js';
import { buildTar } from './testTar.js';

/**
 * A stand-in `kubectl`: logs every invocation (argv and whatever arrived on
 * stdin) and answers from a plan of `{ match, stdout, stderr, code }` rules,
 * first substring match of the joined argv wins.
 */
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stdinWanted = args.includes('-i') || (args.includes('-f') && args.includes('-'));
const stdin = stdinWanted ? fs.readFileSync(0, 'utf8') : null;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin }) + '\\n');
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8'));
const joined = args.join(' ');
const rule = plan.find((r) => joined.includes(r.match)) ?? {};
if (rule.stdout) process.stdout.write(rule.stdout);
if (rule.stderr) process.stderr.write(rule.stderr);
process.exit(rule.code ?? 0);
`;

let dir: string;
let log: string;
let plan: string;
let backend: KubernetesWorkspaceBackend;

const config = (kubectl: string): KubernetesWorkspaceConfig => ({
  imagePullSecrets: [],
  kubectl,
  maxLifetimeSec: 600,
  namespace: 'ns',
  requireNetworkPolicy: true,
  runAsUser: 1000,
  runtimeClassName: null,
  storageLimit: '1Gi',
});

const spec: WorkspaceContainerSpec = {
  cpus: 1,
  dns: [],
  image: 'img:1',
  memory: '1g',
  name: 'workspace-t1',
  pidsLimit: 10,
  reachWorker: false,
};

const setPlan = (rules: object[]) => fs.writeFile(plan, JSON.stringify(rules));
const calls = async (): Promise<{ args: string[]; stdin: string | null }[]> =>
  (await fs.readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-driver-'));
  log = path.join(dir, 'log.jsonl');
  plan = path.join(dir, 'plan.json');
  const bin = path.join(dir, 'kubectl');
  await fs.writeFile(bin, FAKE, { mode: 0o755 });
  process.env.FAKE_LOG = log;
  process.env.FAKE_PLAN = plan;
  await setPlan([]);
  backend = new KubernetesWorkspaceBackend(() => config(bin));
});
afterEach(async () => {
  delete process.env.FAKE_LOG;
  delete process.env.FAKE_PLAN;
  await fs.rm(dir, { force: true, recursive: true });
});

describe('create', () => {
  it('creates the pod from stdin, waits for Ready, and records the keeper pid', async () => {
    await setPlan([{ match: 'asw_ppid', stdout: '42\n' }]);
    const handle = await backend.create(spec);
    expect(handle).toEqual({ id: 'workspace-t1', keeperPid: 42 });

    const [create, wait, probe] = await calls();
    expect(create?.args.slice(0, 5)).toEqual(['create', '--namespace', 'ns', '-f', '-']);
    expect(JSON.parse(create?.stdin ?? '{}').metadata.name).toBe('workspace-t1');
    expect(wait?.args).toEqual(
      expect.arrayContaining(['wait', '--for=condition=Ready', 'pod/workspace-t1'])
    );
    expect(probe?.args.join(' ')).toContain('asw_ppid');
  });

  it('fails closed on zero or several keeper candidates', async () => {
    await setPlan([{ match: 'asw_ppid', stdout: '' }]);
    await expect(backend.create(spec)).rejects.toThrow(/exactly one keeper process/);
    await setPlan([{ match: 'asw_ppid', stdout: '7\n9\n' }]);
    await expect(backend.create(spec)).rejects.toThrow(/exactly one keeper process/);
  });

  it('reports a pod that cannot be created, or never becomes ready', async () => {
    await setPlan([{ code: 1, match: 'create', stderr: 'quota exceeded' }]);
    await expect(backend.create(spec)).rejects.toThrow(/could not create the pod: quota exceeded/);
    await setPlan([{ code: 1, match: 'wait', stderr: 'timed out waiting' }]);
    await expect(backend.create(spec)).rejects.toThrow(/did not become ready/);
  });
});

describe('exec', () => {
  it('runs the command in the workspace container and returns its output', async () => {
    await setPlan([{ match: 'git status', stdout: 'clean\n' }]);
    const res = await backend.exec(backend.attach('workspace-t1'), ['git', 'status'], {
      heartbeatLabel: 't',
      workdir: '/workspace/target-repo',
    });
    expect(res).toMatchObject({ exitCode: 0, stdout: 'clean\n' });
    const [call] = await calls();
    expect(call?.args).toEqual(
      expect.arrayContaining(['exec', '--container', 'workspace', 'workspace-t1', '--'])
    );
  });

  it('drops kubectl’s own exit-code line from stderr', async () => {
    await setPlan([
      { code: 3, match: 'false', stderr: 'boom\ncommand terminated with exit code 3\n' },
    ]);
    const res = await backend.exec(backend.attach('p'), ['false'], { heartbeatLabel: 't' });
    expect(res.exitCode).toBe(3);
    expect(res.stderr).toBe('boom');
  });

  it('sends stdin through kubectl -i', async () => {
    await backend.exec(backend.attach('p'), ['cat'], { heartbeatLabel: 't', stdin: 'payload' });
    const [call] = await calls();
    expect(call?.args).toContain('-i');
    expect(call?.stdin).toBe('payload');
  });

  it('delivers secretEnv on stdin, never in the kubectl argv', async () => {
    // kubectl puts the command in the apiserver URL, which audit logs keep.
    const header = 'AUTHORIZATION: basic c2VjcmV0LXRva2Vu';
    await backend.exec(backend.attach('workspace-t1'), ['sh', '-c', 'git clone x'], {
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: header },
    });
    const [call] = await calls();
    expect(JSON.stringify(call?.args)).not.toContain(header);
    expect(JSON.stringify(call?.args)).not.toContain('c2VjcmV0LXRva2Vu');
    expect(call?.args).toContain('-i');
    expect(call?.args.join(' ')).toContain('read -r');
    expect(call?.stdin).toBe(`ASW_GIT_AUTH=${header}\n\n`);
  });

  it('writes the secret preamble ahead of the caller’s stdin, Buffer included', async () => {
    const header = 'AUTHORIZATION: basic c2VjcmV0';
    await backend.exec(backend.attach('p'), ['cat'], {
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: header },
      stdin: Buffer.from('héllo\n', 'utf8'),
    });
    const [call] = await calls();
    expect(JSON.stringify(call?.args)).not.toContain(header);
    expect(call?.stdin).toBe(`ASW_GIT_AUTH=${header}\n\nhéllo\n`);
  });

  it('execShell carries secretEnv the same way', async () => {
    const header = 'AUTHORIZATION: basic c2VjcmV0';
    await backend.execShell(backend.attach('p'), ['sh', '-c', 'true'], {
      heartbeatLabel: 't',
      secretEnv: { ASW_GIT_AUTH: header },
    });
    const [call] = await calls();
    expect(JSON.stringify(call?.args)).not.toContain(header);
    expect(call?.stdin).toBe(`ASW_GIT_AUTH=${header}\n\n`);
  });

  it('refuses a secret it cannot deliver, before any kubectl call', async () => {
    await expect(
      backend.exec(backend.attach('p'), ['x'], {
        heartbeatLabel: 't',
        secretEnv: { K: 'a\nb' },
      })
    ).rejects.toThrow(/cannot be delivered/);
    expect(await calls()).toHaveLength(0);
  });

  it('uses the plain wrapper when there is no secretEnv', async () => {
    await backend.exec(backend.attach('p'), ['x'], { heartbeatLabel: 't', secretEnv: {} });
    const [call] = await calls();
    expect(call?.args).not.toContain('-i');
    expect(call?.args.join(' ')).not.toContain('read -r');
  });

  it('execShell rejects with the stdout/stderr shape callers expect', async () => {
    await setPlan([{ code: 2, match: 'fail', stderr: 'nope', stdout: 'partial' }]);
    await expect(
      backend.execShell(backend.attach('p'), ['sh', '-c', 'fail'], { heartbeatLabel: 't' })
    ).rejects.toMatchObject({ code: 2, stderr: 'nope', stdout: 'partial' });
  });
});

describe('spawn', () => {
  const run = (child: ReturnType<KubernetesWorkspaceBackend['spawn']>) =>
    new Promise<number | null>((resolve) => child.on('close', resolve));

  it('delivers secrets on stdin, never in argv, then leaves stdin to the caller', async () => {
    const secret = 'sk-live-0123456789';
    const child = backend.spawn(backend.attach('workspace-t1'), ['claude', '--serve'], {
      env: ['MODE=unattended'],
      secretEnv: { ANTHROPIC_API_KEY: secret },
      stdin: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      workdir: '/workspace',
    });
    child.stdin?.end('protocol-line\n');
    expect(await run(child)).toBe(0);

    const [call] = await calls();
    expect(JSON.stringify(call?.args)).not.toContain(secret);
    expect(call?.args).toContain('-i');
    expect(call?.stdin).toBe(`ANTHROPIC_API_KEY=${secret}\n\nprotocol-line\n`);
  });

  it('closes stdin itself when the caller wants none', async () => {
    const child = backend.spawn(backend.attach('p'), ['x'], {
      secretEnv: { K: 'v' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(await run(child)).toBe(0);
    expect((await calls())[0]?.stdin).toBe('K=v\n\n');
  });

  it('refuses an undeliverable secret before kubectl starts', async () => {
    expect(() =>
      backend.spawn(backend.attach('p'), ['x'], {
        secretEnv: { K: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    ).toThrow(/cannot be delivered/);
    expect(await calls()).toHaveLength(0);
  });

  it('uses the plain wrapper, with no stdin, when there are no secrets', async () => {
    const child = backend.spawn(backend.attach('p'), ['x'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(await run(child)).toBe(0);
    const [call] = await calls();
    expect(call?.args).not.toContain('-i');
    expect(call?.args.join(' ')).not.toContain('read -r');
  });
});

describe('copy', () => {
  it('copyIn refuses an unsafe archive before any kubectl call', async () => {
    const tar = path.join(dir, 'evil.tar');
    await fs.writeFile(tar, buildTar([{ linkname: '/etc', name: 'x', type: '2' }]));
    await expect(backend.copyIn(backend.attach('p'), tar, '/stage')).rejects.toThrow(
      /unsafe archive/
    );
    expect(await calls()).toEqual([]);
  });

  it('copyIn extracts a safe archive with tar xf - into the destination', async () => {
    const tar = path.join(dir, 'ok.tar');
    await fs.writeFile(tar, buildTar([{ data: 'hi', name: './a.txt' }]));
    await backend.copyIn(backend.attach('p'), tar, '/stage');
    const [call] = await calls();
    expect(call?.args.slice(-6)).toEqual(['--', 'tar', 'xf', '-', '-C', '/stage']);
    expect(call?.stdin).toContain('a.txt');
  });

  it('copyOut streams the pod’s tar to the file', async () => {
    await setPlan([{ match: 'tar cf', stdout: 'ARCHIVE' }]);
    const dest = path.join(dir, 'out.tar');
    const res = await backend.copyOut(backend.attach('p'), '/workspace/target-repo/.', dest, {
      maxBytes: 1000,
    });
    expect(res).toMatchObject({ exceeded: false, exitCode: 0 });
    expect(await fs.readFile(dest, 'utf8')).toBe('ARCHIVE');
    expect((await calls())[0]?.args.slice(-6)).toEqual([
      'tar',
      'cf',
      '-',
      '-C',
      '/workspace/target-repo',
      '.',
    ]);
  });

  it('copyOut stops at the size cap', async () => {
    await setPlan([{ match: 'tar cf', stdout: 'x'.repeat(5000) }]);
    const res = await backend.copyOut(backend.attach('p'), '/w/.', path.join(dir, 'o.tar'), {
      maxBytes: 100,
    });
    expect(res.exceeded).toBe(true);
  });

  it('copyFileIn carries the file mode so a binary stays executable', async () => {
    const src = path.join(dir, 'bin');
    await fs.writeFile(src, '#!/bin/sh\n', { mode: 0o755 });
    const res = await backend.copyFileIn(backend.attach('p'), src, '/workspace/.harness/x');
    expect(res.exitCode).toBe(0);
    const [call] = await calls();
    expect(call?.args.slice(-2)).toEqual(['/workspace/.harness/x', '755']);
    expect(call?.stdin).toBe('#!/bin/sh\n');
  });

  it('copyFileIn reports a failure instead of throwing', async () => {
    const src = path.join(dir, 'bin');
    await fs.writeFile(src, 'x');
    await setPlan([{ code: 1, match: 'asw-tmp', stderr: 'read-only file system' }]);
    const res = await backend.copyFileIn(backend.attach('p'), src, '/ro/x');
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('read-only');
  });
});

describe('pause and remove', () => {
  it('pause stops every process it may signal', async () => {
    await backend.pause(backend.attach('p'));
    expect((await calls())[0]?.args.join(' ')).toContain('kill -STOP -1');
  });

  it('remove deletes the pod and never throws', async () => {
    await setPlan([{ code: 1, match: 'delete', stderr: 'gone' }]);
    await expect(backend.remove('workspace-t1')).resolves.toBeUndefined();
    expect((await calls())[0]?.args.slice(0, 3)).toEqual(['delete', 'pod', 'workspace-t1']);
  });
});

describe('what the Kubernetes backend does not do yet', () => {
  it('fails shell, container and sidecar work closed, with a non-retryable failure', async () => {
    const attempts = [
      backend.createVolume('v'),
      backend.runEphemeral({ image: 'i' }, {}),
      backend.startDetached({ image: 'i' }, {}),
      backend.runHelper({ image: 'i' }, {}),
      backend.sidecarBaseUrl('n', 80),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        nonRetryable: true,
        type: 'WORKSPACE_BACKEND_UNSUPPORTED',
      });
    }
    expect(await calls()).toEqual([]);
  });

  it('lets cleanup of a volume that was never made succeed', async () => {
    await expect(backend.removeVolume('v')).resolves.toBeUndefined();
  });

  it('judges a proxy URL reachable unless it uses the Docker host alias', () => {
    expect(backend.canReachWorkerProxy('http://worker-proxy.auto-swe.svc:9000')).toBe(true);
    expect(backend.canReachWorkerProxy('http://host.docker.internal:9000')).toBe(false);
  });
});
