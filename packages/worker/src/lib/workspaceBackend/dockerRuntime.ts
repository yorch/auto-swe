import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { spawnCaptureAsync } from '../execUtils.js';
import { dockerWorkspaceBackend } from './docker.js';
import { workspaceLabelArgs } from './orphans.js';
import { agentWorkspaceSpec } from './spec.js';
import type { WorkspaceBackend } from './types.js';

export async function assertDockerRuntime(
  backend: WorkspaceBackend = dockerWorkspaceBackend()
): Promise<void> {
  const infra = resolveWorkspaceInfra();
  if (infra.backend !== 'docker' || !infra.runtime) {
    return;
  }
  const runtime = infra.runtime;
  const name = `workspace-runtime-${crypto.randomBytes(6).toString('hex')}`;
  const probe = `${name}-inspect`;
  const peer = `${name}-peer`;
  const marker = crypto.randomBytes(16).toString('hex');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'asw-runtime-'));
  let stage = 'runtime startup/inspection';
  const options = { heartbeatLabel: 'workspace: checking Docker runtime', timeoutMs: 30_000 };
  const docker = async (args: string[]) => {
    const result = await spawnCaptureAsync('docker', args, options);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `docker ${args[0]} exited ${result.exitCode}`);
    }
    return result.stdout.trim();
  };
  try {
    await docker([
      'run',
      '-d',
      '--name',
      probe,
      ...workspaceLabelArgs(),
      '--label=auto-swe.profile=probe',
      `--runtime=${runtime}`,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--memory=128m',
      '--cpus=1',
      '--pids-limit=64',
      '--',
      infra.metadataBlockImage,
      'sleep',
      'infinity',
    ]);
    const inspected = await docker(['inspect', '--format', '{{.HostConfig.Runtime}}', probe]);
    if (inspected !== runtime) {
      throw new Error(`requested ${runtime}, Docker returned runtime ${JSON.stringify(inspected)}`);
    }

    stage = 'workspace creation/baseline';
    const handle = await backend.create(agentWorkspaceSpec(name, infra.metadataBlockImage, infra));
    const workspace = JSON.parse(await docker(['inspect', '--format', '{{json .}}', name]));
    if (workspace.HostConfig?.Runtime !== runtime) {
      throw new Error(`workspace did not use runtime ${runtime}`);
    }
    let networks = workspace.NetworkSettings?.Networks;
    const networkMode = workspace.HostConfig?.NetworkMode;
    if (
      !Object.keys(networks ?? {}).length &&
      typeof networkMode === 'string' &&
      networkMode.startsWith('container:')
    ) {
      const holder = JSON.parse(
        await docker(['inspect', '--format', '{{json .}}', networkMode.slice('container:'.length)])
      );
      if (
        holder.Config?.Labels?.['auto-swe.workspace'] !== 'true' ||
        holder.Config?.Labels?.['asw.workspace'] !== name
      ) {
        throw new Error('workspace network holder is not owned by the runtime probe');
      }
      networks = holder.NetworkSettings?.Networks;
    }
    const network = Object.keys(networks ?? {})[0];
    if (!network) {
      throw new Error('workspace has no Docker network');
    }
    const exec = (argv: string[]) => backend.exec(handle, argv, options);
    const tools = await exec([
      'sh',
      '-c',
      'command -v wget >/dev/null && command -v nc >/dev/null',
    ]);
    if (tools.exitCode !== 0) {
      throw new Error('probe image requires wget and nc');
    }

    stage = 'baseline private-peer HTTP';
    await docker([
      'run',
      '-d',
      '--name',
      peer,
      ...workspaceLabelArgs(),
      '--label=auto-swe.profile=probe',
      '--network',
      network,
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--memory=64m',
      '--cpus=1',
      '--pids-limit=32',
      '--',
      infra.metadataBlockImage,
      'sh',
      '-c',
      `mkdir -p /www && echo ${marker} > /www/index.html && exec httpd -f -p 8080 -h /www`,
    ]);
    const ready = await docker([
      'exec',
      peer,
      'sh',
      '-c',
      'for n in 1 2 3 4 5; do wget -q -T 1 -O - http://127.0.0.1:8080/ && exit 0; sleep 1; done; exit 1',
    ]);
    if (ready !== marker) {
      throw new Error('peer HTTP positive control failed');
    }
    const ip = await docker([
      'inspect',
      '--format',
      `{{(index .NetworkSettings.Networks ${JSON.stringify(network)}).IPAddress}}`,
      peer,
    ]);
    if (isIP(ip) !== 4) {
      throw new Error('peer has no IPv4 address');
    }
    const http = await exec(['wget', '-q', '-T', '5', '-t', '1', '-O', '-', `http://${ip}:8080/`]);
    if (http.exitCode === 0 || http.stdout.includes(marker)) {
      throw new Error('baseline traffic leak: workspace reached private peer HTTP');
    }
    if (!/refused|timed out|unreachable|not permitted|no route/i.test(http.stderr)) {
      throw new Error(`private-peer result is inconclusive: ${http.stderr.trim()}`);
    }

    stage = 'blocked public TCP';
    const connect = () => exec(['nc', '-z', '-w', '5', '1.1.1.1', '443']);
    const before = await connect();
    await backend.lockEgress(handle, [], { mode: 'blocked' });
    const after = await connect();
    const inconclusive = before.exitCode !== 0;
    if (after.exitCode === 0) {
      throw new Error(
        'blocked traffic leak: public TCP 1.1.1.1:443 is reachable' +
          (inconclusive ? ' (public TCP pre-check was inconclusive)' : '')
      );
    }
    if (inconclusive) {
      throw new Error(
        'public TCP pre-check to 1.1.1.1:443 failed before locking; enforcement is inconclusive'
      );
    }

    stage = 'docker cp round trip';
    const source = path.join(dir, 'in');
    const destination = path.join(dir, 'out');
    const containerPath = '/workspace/.runtime-probe';
    const mkdir = await exec(['mkdir', '-p', '/workspace']);
    if (mkdir.exitCode !== 0) {
      throw new Error(mkdir.stderr || 'cannot create /workspace');
    }
    await fs.writeFile(source, marker);
    const copied = await backend.copyFileIn(handle, source, containerPath, options);
    if (copied.exitCode !== 0) {
      throw new Error(copied.stderr || 'docker cp into workspace failed');
    }
    const read = await exec(['cat', containerPath]);
    if (read.exitCode !== 0 || read.stdout !== marker) {
      throw new Error('docker cp into running workspace is not visible via exec');
    }
    await docker(['cp', `${name}:${containerPath}`, destination]);
    if ((await fs.readFile(destination, 'utf8')) !== marker) {
      throw new Error('docker cp out of running workspace did not match');
    }
    console.info(
      `[workspace] Docker runtime ${runtime}: inspection, baseline traffic, blocked TCP and copy checks passed`
    );
  } catch (error) {
    throw new Error(
      `WORKSPACE_RUNTIME=${runtime}: ${stage} check failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  } finally {
    const cleanup = await Promise.allSettled([
      backend.remove(name),
      spawnCaptureAsync('docker', ['rm', '-f', probe, peer], options),
      fs.rm(dir, { force: true, recursive: true }),
    ]);
    for (const result of cleanup) {
      if (result.status === 'rejected') {
        console.warn(`[workspace] runtime probe cleanup failed for ${name}`, result.reason);
      }
    }
  }
}
