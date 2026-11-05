import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KubernetesWorkspaceConfig } from '@auto-swe/shared/lib/systemConfig';
import type { ResolvedTool, ToolCatalogEntry } from '@auto-swe/shared/lib/toolCatalog';
import { ApplicationFailure } from '@temporalio/activity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));

import { toolInstallScript } from '../../toolInstall.js';
import { installResolvedTools, toToolInstallFailure } from '../../workspaceTools.js';
import type { WorkspaceContainerSpec } from '../types.js';
import { KubernetesWorkspaceBackend } from './driver.js';
import { buildWorkspacePod, WORKSPACE_MOUNT } from './podSpec.js';

/**
 * Kubernetes parity for the on-demand tool install. The script runs through the same
 * `backend.execShell` as under Docker, so what matters here is (a) the pod gives a non-root user a
 * writable `/workspace` to install into and (b) the install travels as one plain command: no
 * credential in `env`, nothing from the catalog in `env`, and its exit code survives the exec.
 *
 * Not covered: a real cluster. Nothing here proves a given CSI driver or PodSecurity admission
 * honours `fsGroup` on an `emptyDir`, or that the cluster's `emptyDir` is not mounted `noexec` by
 * the node's configuration; the pod spec only states the intent.
 */

const config = (kubectl = 'kubectl'): KubernetesWorkspaceConfig => ({
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

describe('pod spec preconditions for a non-root /workspace/.tools install', () => {
  const pod = buildWorkspacePod(spec, config()) as unknown as {
    spec: {
      containers: {
        securityContext: Record<string, unknown>;
        volumeMounts: { mountPath: string; name: string; readOnly?: boolean }[];
      }[];
      securityContext: Record<string, unknown>;
      volumes: { emptyDir?: Record<string, unknown>; name: string }[];
    };
  };
  const container = pod.spec.containers[0];

  it('runs non-root with every capability dropped and no privilege escalation', () => {
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      runAsNonRoot: true,
      runAsUser: 1000,
    });
  });

  it('backs /workspace with a writable emptyDir the configured uid owns through fsGroup', () => {
    expect(pod.spec.securityContext).toMatchObject({
      fsGroup: 1000,
      runAsGroup: 1000,
      runAsNonRoot: true,
      runAsUser: 1000,
    });
    const mount = container.volumeMounts.find((m) => m.mountPath === WORKSPACE_MOUNT);
    expect(mount).toBeDefined();
    const volume = pod.spec.volumes.find((v) => v.name === mount?.name);
    expect(volume?.emptyDir).toBeDefined();
  });

  it('does not mount /workspace read-only or in any way that would imply noexec', () => {
    const mount = container.volumeMounts.find((m) => m.mountPath === WORKSPACE_MOUNT);
    expect(mount).toEqual({ mountPath: WORKSPACE_MOUNT, name: 'workspace' });
    expect(mount).not.toHaveProperty('readOnly');
    const volume = pod.spec.volumes.find((v) => v.name === 'workspace');
    // A memory-backed emptyDir is a tmpfs; the spec must not choose one, and has no mount-option
    // field at all, so there is nothing to carry `noexec`.
    expect(Object.keys(volume?.emptyDir ?? {})).toEqual(['sizeLimit']);
    expect(JSON.stringify(pod.spec)).not.toMatch(/noexec|readOnlyRootFilesystem|"medium"/i);
    expect(container.securityContext).not.toHaveProperty('readOnlyRootFilesystem');
  });
});

/** A stand-in `kubectl` that logs argv and stdin and answers from a plan. */
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const stdinWanted = args.includes('-i') || (args.includes('-f') && args.includes('-'));
const stdin = stdinWanted ? fs.readFileSync(0, 'utf8') : null;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args, stdin }) + '\\n');
const plan = JSON.parse(fs.readFileSync(process.env.FAKE_PLAN, 'utf8'));
const joined = args.join(' ');
const rule = plan.find((r) => joined.includes(r.match)) ?? {};
if (rule.stderr) process.stderr.write(rule.stderr);
process.exit(rule.code ?? 0);
`;

const entry: ToolCatalogEntry = {
  archs: {
    amd64: { sha256: 'a'.repeat(64), url: 'https://example.test/faketool-amd64.tar.gz' },
    arm64: { sha256: 'a'.repeat(64), url: 'https://example.test/faketool-arm64.tar.gz' },
  },
  key: 'faketool',
  libc: 'any',
  member: 'faketool',
  status: 'ACTIVE',
  version: '1.0.0',
};
const resolved: ResolvedTool[] = [{ entry }];

describe('installResolvedTools through the Kubernetes backend', () => {
  let dir: string;
  let log: string;
  let plan: string;
  let backend: KubernetesWorkspaceBackend;

  const setPlan = (rules: object[]) => fs.writeFile(plan, JSON.stringify(rules));
  const calls = async (): Promise<{ args: string[]; stdin: string | null }[]> =>
    (await fs.readFile(log, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const install = () => {
    const handle = backend.attach('workspace-t1');
    return installResolvedTools(
      (command, timeoutMs) =>
        backend.execShell(handle, ['sh', '-c', command], {
          heartbeatLabel: 'tool-install',
          timeoutMs,
          workdir: '/workspace',
        }),
      resolved
    );
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-tool-install-'));
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

  it('sends the install script as the command, with no env and nothing on stdin', async () => {
    const result = await install();
    expect(result.installed).toEqual([{ key: 'faketool', version: '1.0.0' }]);

    const [call] = await calls();
    const script = toolInstallScript([entry]);
    expect(call?.args.slice(-3)).toEqual(['sh', '-c', script]);
    // `env NAME=value` is how the driver renders `opts.env`; secrets would instead need stdin.
    expect(call?.args).not.toContain('env');
    expect(call?.args).not.toContain('-i');
    expect(call?.stdin).toBeNull();
    // Nothing the catalog says reaches the exec as an assignment: the URL and checksum live only
    // inside the script text.
    const beforeScript = call?.args.slice(0, -1) ?? [];
    expect(beforeScript.join(' ')).not.toMatch(/example\.test|aaaaaaaa|faketool/);
  });

  it('maps exit 75 to a retryable failure', async () => {
    await setPlan([
      {
        code: 75,
        match: 'sha256sum',
        stderr: 'auto-swe tool install: faketool@1.0.0: download failed from https://x\n',
      },
    ]);
    const err = await install().then(
      () => null,
      (e: unknown) => toToolInstallFailure(e)
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ApplicationFailure);
    expect((err as Error).message).toContain('download failed');
  });

  it('maps exit 1 to a non-retryable TOOL_INSTALL_FAILED', async () => {
    await setPlan([
      {
        code: 1,
        match: 'sha256sum',
        stderr: 'auto-swe tool install: faketool@1.0.0: checksum mismatch\n',
      },
    ]);
    const err = await install().then(
      () => null,
      (e: unknown) => toToolInstallFailure(e)
    );
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ nonRetryable: true, type: 'TOOL_INSTALL_FAILED' });
    expect((err as Error).message).toContain('checksum mismatch');
  });
});
