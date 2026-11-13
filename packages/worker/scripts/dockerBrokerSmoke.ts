import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceHandle } from '../src/lib/workspaceBackend/types.js';

const image = process.env.BROKER_SMOKE_IMAGE ?? 'asw-broker-fixture:ci';
Object.assign(process.env, {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://fixture:fixture@127.0.0.1:1/fixture',
  DOCKER_BROKER_REQUIRED: 'true',
  WORKSPACE_BACKEND: 'docker',
  WORKSPACE_BLOCK_METADATA: 'true',
  WORKSPACE_BLOCK_PRIVATE_EGRESS: 'true',
  WORKSPACE_CPUS: '1',
  WORKSPACE_MEMORY: '512m',
  WORKSPACE_METADATA_BLOCK_IMAGE: image,
  WORKSPACE_RUN_AS_ROOT: 'false',
});
delete process.env.WORKSPACE_NETWORK;
delete process.env.WORKSPACE_RUNTIME;
const { dockerWorkspaceBackend } = await import('../src/lib/workspaceBackend/docker.js');
const { assertDockerBroker } = await import('../src/lib/workspaceBackend/dockerBroker.js');
const backend = dockerWorkspaceBackend();
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'broker-smoke-'));
const name = `broker-workspace-${randomUUID()}`;
const sidecar = `broker-sidecar-${randomUUID()}`;
let volume = '';
let workspace: WorkspaceHandle | undefined;
try {
  await assertDockerBroker();
  workspace = await backend.create({
    cpus: 1,
    dns: ['1.1.1.1'],
    image,
    memory: '512m',
    name,
    pidsLimit: 256,
    reachWorker: false,
    services: [{ image, name: 'preview', readyCommand: 'true' }],
  });
  const options = { heartbeatLabel: 'broker smoke', timeoutMs: 30_000 };
  assert.equal(
    (
      await backend.exec(workspace, ['sh', '-c', 'cat; echo done'], {
        ...options,
        stdin: 'stdin\n',
      })
    ).stdout,
    'stdin\ndone\n'
  );
  console.info('workspace create/bootstrap, preview service and real exec stdin PASS');
  await fs.writeFile(path.join(root, 'input'), 'copy bytes\n');
  await backend.copyFileIn(workspace, path.join(root, 'input'), '/workspace/input');
  await backend.copyOut(workspace, '/workspace/input', path.join(root, 'output.tar'));
  assert.match(
    execFileSync('tar', ['-xOf', path.join(root, 'output.tar')], { encoding: 'utf8' }),
    /copy bytes/
  );
  console.info('archive copy in/out PASS');
  await backend.execShell(
    workspace,
    ['sh', '-c', 'sleep 300 >/dev/null 2>&1 & echo $! >/workspace/setup.pid'],
    options
  );
  const namespace = (
    await backend.exec(workspace, ['readlink', `/proc/${workspace.keeperPid}/ns/mnt`], options)
  ).stdout.trim();
  const cleanup = `kill -KILL "$(cat /proc/${workspace.keeperPid}/root/workspace/setup.pid)"`;
  await backend.clearSetupProcesses(workspace, cleanup, namespace);
  console.info('setup PID cleanup helper PASS');
  await backend.lockEgress(workspace, [{ host: 'broker.fixture', port: 443 }], {
    prepareOnly: true,
  });
  await backend.lockEgress(workspace, [{ host: 'broker.fixture', port: 443 }], {
    prepareOnly: true,
    replace: true,
  });
  console.info('broker-derived hosts writer after non-root exec PASS');
  await backend.lockEgress(workspace, [], { replace: true });
  const refused = await backend.exec(
    workspace,
    ['curl', '-fsS', '--connect-timeout', '2', 'http://1.1.1.1'],
    options
  );
  assert.notEqual(refused.exitCode, 0);
  console.info('baseline and blocked egress lock PASS');
  volume = await backend.createVolume('broker-smoke');
  await backend.runHelper(
    {
      argv: ['-ec', 'echo volume > /workspace/file'],
      entrypoint: 'sh',
      image,
      volumes: [{ source: volume, target: '/workspace' }],
    },
    options
  );
  const author = await backend.runEphemeral(
    {
      argv: ['sh', '-ec', 'cat /workspace/file'],
      env: [],
      image,
      name: `broker-author-${randomUUID()}`,
      network: 'egress',
      volumes: [{ source: volume, target: '/workspace' }],
    },
    options
  );
  assert.equal(author.exitCode, 0);
  assert.match(author.stdout, /volume/);
  const started = await backend.startDetached(
    {
      argv: [
        'node',
        '-e',
        'require("http").createServer((q,s)=>s.end("sidecar")).listen(8080,"0.0.0.0")',
      ],
      env: [],
      image,
      name: sidecar,
      network: 'egress',
      publishPort: 8080,
      reachWorker: true,
      volumes: [{ source: volume, target: '/workspace' }],
    },
    options
  );
  assert.equal(started.exitCode, 0, started.stderr);
  const url = await backend.sidecarBaseUrl(sidecar, 8080);
  assert.equal(await (await fetch(url, { signal: AbortSignal.timeout(10_000) })).text(), 'sidecar');
  console.info('shell git helper, author holder and detached sidecar PASS');

  const endpoint = (process.env.DOCKER_HOST ?? '').replace(/^tcp:/, 'http:');
  const base = {
    HostConfig: {
      CapDrop: ['ALL'],
      Memory: 134217728,
      NanoCpus: 1e9,
      NetworkMode: 'bridge',
      PidsLimit: 64,
      SecurityOpt: ['no-new-privileges'],
    },
    Image: image,
    Labels: { 'auto-swe.profile': 'workspace' },
    User: '1000',
  };
  for (const change of [
    { Privileged: true },
    { Binds: ['/:/host'] },
    { Binds: ['/var/run/docker.sock:/socket'] },
    { PidMode: 'host' },
    { NetworkMode: 'host' },
    { Devices: [{ PathInContainer: '/dev/kmsg', PathOnHost: '/dev/kmsg' }] },
    { SecurityOpt: ['seccomp=unconfined'] },
    { SecurityOpt: ['apparmor=unconfined'] },
    { CapAdd: ['SYS_ADMIN'] },
  ]) {
    const response = await fetch(`${endpoint}/containers/create`, {
      body: JSON.stringify({ ...base, HostConfig: { ...base.HostConfig, ...change } }),
      method: 'POST',
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /ASW_DOCKER_BROKER_DENIED/);
  }
  for (const [target, body] of [
    ['/volumes/create', { DriverOpts: { device: '/', o: 'bind', type: 'none' } }],
    [
      '/containers/create',
      { ...base, Labels: { ...base.Labels, 'io.auto-swe.broker.owner': 'forged' } },
    ],
    ['/containers/create', '{"Image":"x","Image":"y"}'],
  ] as const) {
    assert.equal(
      (
        await fetch(`${endpoint}${target}`, {
          body: typeof body === 'string' ? body : JSON.stringify(body),
          method: 'POST',
        })
      ).status,
      403
    );
  }
  assert.equal((await fetch(`${endpoint}/containers/non-owned/json`)).status, 403);
  console.info(
    'all privileged/bind/namespace/device/security/cap/volume/forgery/duplicate negatives PASS'
  );
  if (process.env.BROKER_SMOKE_RESTART) {
    execFileSync('docker', ['restart', process.env.BROKER_SMOKE_RESTART], {
      env: { ...process.env, DOCKER_HOST: 'unix:///var/run/docker.sock' },
    });
    let restored = false;
    for (let i = 0; i < 30 && !restored; i++) {
      try {
        restored = (await fetch(`${endpoint}/_ping`)).ok;
      } catch {}
      if (!restored) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert(restored, 'broker did not reconstruct ownership');
    assert.equal((await backend.exec(workspace, ['id', '-u'], options)).stdout.trim(), '1000');
    assert.equal(
      (
        await fetch(`${endpoint}/containers/${name}/exec`, {
          body: JSON.stringify({ Cmd: ['id'], User: '0:1000' }),
          method: 'POST',
        })
      ).status,
      403
    );
    assert.match(docker('volume', 'inspect', volume), /asw-volume-/);
    console.info('broker restart retains container/volume ownership and sealed root phase PASS');
  }
} finally {
  await backend.remove(sidecar);
  await backend.remove(workspace ?? name);
  if (volume) {
    await backend.removeVolume(volume);
  }
  await fs.rm(root, { force: true, recursive: true });
}
assert.equal(docker('ps', '-aq', '--filter', `name=${name}`), '');
console.info('workspace, preview service, holder, sidecar and volume cleanup PASS');
console.info('broker full-stack backend smoke PASS');
