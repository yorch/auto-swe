import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KubernetesWorkspaceConfig } from '@auto-swe/shared/lib/systemConfig';
import { resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { killStrayProcessesScript, type Workspace } from '../../../activities/workspace.js';
import { BrowserSession } from '../../../browser/session.js';
import { startAppPreview } from '../../appPreview.js';
import type { WorkspaceContainerSpec, WorkspaceHandle } from '../types.js';
import { KubernetesWorkspaceBackend } from './driver.js';
import { probeScript } from './egressLock.js';
import { readSingleFileFromArchive } from './safeTar.js';
import { buildTar } from './testTar.js';

const enabled = process.env.K8S_KIND_TEST === '1';
const EVIDENCE_DIR = process.env.K8S_KIND_EVIDENCE_DIR;
const POD_SECURITY_ENFORCE = 'pod-security.kubernetes.io/enforce';
const PUBLIC_TARGETS = [
  { host: '1.1.1.1', port: 80 },
  { host: '1.1.1.1', port: 443 },
  { host: '8.8.8.8', port: 443 },
  { host: '9.9.9.9', port: 443 },
];
const TCP_PROBE = [
  'const net = require("node:net");',
  'const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) });',
  'const timeout = setTimeout(() => { socket.destroy(); process.stderr.write("timeout"); process.exit(2); }, 5000);',
  'socket.once("connect", () => { clearTimeout(timeout); process.stdout.write("connected"); socket.end(); });',
  'socket.once("error", (error) => { clearTimeout(timeout); process.stderr.write(error.code ?? "error"); process.exit(1); });',
].join('\n');

describe.skipIf(!enabled)('Kubernetes workspace kind integration', () => {
  let config: KubernetesWorkspaceConfig;
  let backend: KubernetesWorkspaceBackend;
  let originalEnforce: string;
  let workspaceName: string | undefined;

  function kubectl(args: string[]): string {
    const result = spawnSync(config.kubectl, args, { encoding: 'utf8', timeout: 30_000 });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`kubectl ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  function setEnforce(level: string): void {
    kubectl([
      'label',
      'namespace',
      config.namespace,
      `${POD_SECURITY_ENFORCE}=${level}`,
      '--overwrite',
    ]);
  }

  function namespaceEnforce(): string {
    const namespace = JSON.parse(kubectl(['get', 'namespace', config.namespace, '-o', 'json'])) as {
      metadata: { labels: Record<string, string> };
    };
    return namespace.metadata.labels[POD_SECURITY_ENFORCE] ?? '';
  }

  async function exec(
    handle: WorkspaceHandle,
    argv: string[],
    timeoutMs = 30_000
  ): Promise<string> {
    const result = await backend.exec(handle, argv, {
      heartbeatLabel: 'kind workspace integration',
      timeoutMs,
      workdir: '/workspace/target-repo',
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `workspace command exited ${result.exitCode}`);
    }
    return result.stdout;
  }

  function integrationSpec(
    name: string,
    services: WorkspaceContainerSpec['services'],
    secretEnv?: Record<string, string>
  ): WorkspaceContainerSpec {
    return {
      cpus: 1,
      dns: [],
      image: 'auto-swe/node-browser:phase-a',
      memory: '2g',
      name,
      pidsLimit: 512,
      reachWorker: false,
      ...(secretEnv ? { secretEnv } : {}),
      ...(services ? { services } : {}),
    };
  }

  function workspaceAdapter(handle: WorkspaceHandle): Workspace {
    const commandOptions = (options?: {
      timeoutMs?: number;
      secretEnv?: Record<string, string>;
    }) => ({
      heartbeatLabel: 'kind workspace integration',
      workdir: '/workspace/target-repo',
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options?.secretEnv ? { secretEnv: options.secretEnv } : {}),
    });
    return {
      containerId: handle.id,
      exec: (
        command: string,
        options?: { timeoutMs?: number; secretEnv?: Record<string, string> }
      ) => backend.execShell(handle, ['sh', '-c', command], commandOptions(options)),
      execCapture: (
        command: string,
        options?: { timeoutMs?: number; secretEnv?: Record<string, string> }
      ) => backend.exec(handle, ['sh', '-c', command], commandOptions(options)),
      execStdin: async (command: string, stdin: string) => {
        const result = await backend.exec(handle, ['sh', '-c', command], {
          ...commandOptions(),
          stdin,
        });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || `workspace command exited ${result.exitCode}`);
        }
        return result.stdout;
      },
      gitIdentity: { email: 'kind-test@example.invalid', name: 'Kubernetes kind test' },
      readFile: async (filePath: string, maxBytes: number) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-kind-file-'));
        const archive = path.join(dir, 'file.tar');
        try {
          await backend.copyOut(handle, filePath, archive, { maxBytes });
          return await readSingleFileFromArchive(archive, maxBytes);
        } finally {
          await fs.rm(dir, { force: true, recursive: true });
        }
      },
    } as unknown as Workspace;
  }

  async function tcpConnect(handle: WorkspaceHandle, host: string, port: number): Promise<string> {
    return exec(handle, ['node', '-e', TCP_PROBE, host, String(port)]);
  }

  async function publicProbe(handle: WorkspaceHandle, target: (typeof PUBLIC_TARGETS)[number]) {
    const result = await backend.exec(handle, ['sh', '-c', probeScript(target)], {
      heartbeatLabel: 'kind workspace integration',
      timeoutMs: 15_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `public TCP probe exited ${result.exitCode}`);
    }
    return /asw_probe=(open|closed|notool|error)/.exec(result.stdout)?.[1] ?? 'unknown';
  }

  async function expectNotFound(resource: string, name: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const result = spawnSync(
        config.kubectl,
        ['get', resource, name, '--namespace', config.namespace, '-o', 'json'],
        { encoding: 'utf8', timeout: 10_000 }
      );
      if (result.error) {
        throw result.error;
      }
      const output = `${result.stderr}\n${result.stdout}`;
      if (result.status !== 0 && /notfound|not found/i.test(output)) {
        return;
      }
      if (result.status !== 0) {
        throw new Error(`kubectl get ${resource} ${name} failed: ${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`${resource}/${name} still exists after workspace removal`);
  }

  beforeAll(() => {
    config = resolveWorkspaceInfra().kubernetes;
    backend = new KubernetesWorkspaceBackend(() => config);
    originalEnforce = namespaceEnforce();
    expect(originalEnforce).toBe('restricted');
  });

  afterEach(async () => {
    if (workspaceName) {
      await backend.remove(workspaceName);
      workspaceName = undefined;
    }
    if (originalEnforce) {
      setEnforce(originalEnforce);
    }
  });

  it('runs a service-backed browser preview, locks egress, and removes its pod and Secret', async () => {
    const name = `workspace-kind-${randomBytes(4).toString('hex')}`;
    workspaceName = name;
    const workspaceSecret = randomBytes(16).toString('hex');
    const postgresPassword = randomBytes(16).toString('hex');
    const spec = integrationSpec(
      name,
      [
        {
          env: {
            POSTGRES_DB: 'kind_test',
            POSTGRES_PASSWORD: postgresPassword,
            POSTGRES_USER: 'postgres',
          },
          image: 'mirror.gcr.io/library/postgres:18',
          name: 'postgres',
          port: 5432,
          readyCommand: 'pg_isready -h 127.0.0.1 -p 5432 -U postgres',
        },
      ],
      { KIND_TEST_SECRET: workspaceSecret }
    );

    expect(namespaceEnforce()).toBe(originalEnforce);
    setEnforce('baseline');

    let handle: WorkspaceHandle | undefined;
    let previewStop: (() => Promise<void>) | undefined;
    let browser: BrowserSession | undefined;
    try {
      handle = await backend.create(spec);
      const repositoryDirectory = await backend.exec(
        handle,
        ['mkdir', '-p', '/workspace/target-repo'],
        {
          heartbeatLabel: 'kind workspace integration',
          timeoutMs: 30_000,
          workdir: '/workspace',
        }
      );
      expect(repositoryDirectory.exitCode).toBe(0);

      const uid = await exec(handle, ['id', '-u']);
      expect(uid.trim()).toBe('1000');
      const secretHash = await exec(handle, [
        'node',
        '-e',
        'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.KIND_TEST_SECRET).digest("hex"))',
      ]);
      expect(secretHash.trim()).toBe(createHash('sha256').update(workspaceSecret).digest('hex'));

      const podText = kubectl(['get', 'pod', name, '--namespace', config.namespace, '-o', 'json']);
      expect(podText).not.toContain(workspaceSecret);
      expect(podText).not.toContain(postgresPassword);
      const pod = JSON.parse(podText) as {
        spec: {
          containers: {
            name: string;
            securityContext?: {
              runAsUser?: number;
              capabilities?: { add?: string[]; drop?: string[] };
            };
          }[];
        };
      };
      const workspaceContainer = pod.spec.containers.find(
        (container) => container.name === 'workspace'
      );
      expect(workspaceContainer?.securityContext?.runAsUser).toBe(1000);
      expect(workspaceContainer?.securityContext?.capabilities?.add ?? []).toEqual([]);
      expect(workspaceContainer?.securityContext?.capabilities?.drop).toContain('ALL');
      expect(await tcpConnect(handle, '127.0.0.1', 5432)).toBe('connected');

      const sweep = await backend.exec(
        handle,
        ['sh', '-c', killStrayProcessesScript(handle.keeperPid)],
        {
          heartbeatLabel: 'kind workspace integration',
          timeoutMs: 30_000,
          workdir: '/workspace/target-repo',
        }
      );
      expect(sweep.exitCode).toBe(0);
      expect(await tcpConnect(handle, '127.0.0.1', 5432)).toBe('connected');

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'k8s-kind-preview-'));
      const archive = path.join(tempDir, 'preview.tar');
      try {
        await fs.writeFile(
          archive,
          buildTar([
            {
              data: [
                "const http = require('node:http');",
                'http.createServer((_request, response) => {',
                "  response.writeHead(200, { 'content-type': 'text/html' });",
                "  response.end('<!doctype html><title>Kind Preview</title><main>Ready from kind</main>');",
                "}).listen(4173, '0.0.0.0');",
              ].join('\n'),
              name: 'server.js',
            },
          ])
        );
        await backend.copyIn(handle, archive, '/workspace/target-repo');
      } finally {
        await fs.rm(tempDir, { force: true, recursive: true });
      }

      const preview = await startAppPreview(
        workspaceAdapter(handle),
        {
          allowedHosts: ['127.0.0.1', 'localhost'],
          baseUrl: 'http://127.0.0.1:4173',
          readyTimeoutMs: 60_000,
          readyUrl: 'http://127.0.0.1:4173/',
          start: 'node server.js',
        },
        { timeoutMs: 60_000 }
      );
      previewStop = preview.stop;

      browser = await BrowserSession.start(workspaceAdapter(handle), {
        allowedHosts: ['127.0.0.1', 'localhost'],
        recordVideo: true,
        trace: true,
        viewport: { height: 480, width: 640 },
      });
      const navigation = await browser.call({ cmd: 'goto', url: preview.baseUrl });
      expect(navigation).toMatchObject({ ok: true, status: 200, title: 'Kind Preview' });
      const screenshot = await browser.call({ cmd: 'screenshot' });
      expect(screenshot.ok).toBe(true);
      const screenshotPath = typeof screenshot.file === 'string' ? screenshot.file : '';
      expect(screenshotPath).not.toBe('');
      const png = await browser.readOutFile(screenshotPath, 2 * 1024 * 1024);
      expect(png.length).toBeGreaterThan(0);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if (EVIDENCE_DIR) {
        await fs.writeFile(path.join(EVIDENCE_DIR, 'workspace-preview.png'), png);
      }
      const outputs = await browser.close();
      browser = undefined;
      expect(outputs.errors).toEqual([]);
      expect(outputs.video?.length ?? 0).toBeGreaterThan(0);
      expect(outputs.video?.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      expect(outputs.trace?.length ?? 0).toBeGreaterThan(0);
      expect(outputs.trace?.subarray(0, 2).toString()).toBe('PK');

      let reachableTarget: (typeof PUBLIC_TARGETS)[number] | undefined;
      for (const target of PUBLIC_TARGETS) {
        if ((await publicProbe(handle, target)) === 'open') {
          reachableTarget = target;
          break;
        }
      }
      expect(reachableTarget).toBeDefined();
      if (!reachableTarget) {
        throw new Error('no public probe target was reachable before locking egress');
      }
      await backend.lockEgress(handle, []);
      expect(await publicProbe(handle, reachableTarget)).toBe('closed');
      expect(await tcpConnect(handle, '127.0.0.1', 5432)).toBe('connected');
      expect(await tcpConnect(handle, '127.0.0.1', 4173)).toBe('connected');

      await previewStop();
      previewStop = undefined;
      await backend.remove(handle);
      handle = undefined;
      workspaceName = undefined;
      await expectNotFound('pod', name);
      await expectNotFound('secret', `${name}-env`);
      expect(await backend.reapOrphans(new Date())).toEqual({
        failed: [],
        removed: [],
        scanned: 0,
      });
    } finally {
      await browser?.close().catch(() => undefined);
      await previewStop?.().catch(() => undefined);
      if (handle) {
        await backend.remove(handle);
      }
    }
  }, 300_000);

  it('rejects a root-needing service under the restricted namespace with a Pod Security error', async () => {
    const name = `workspace-kind-root-${randomBytes(4).toString('hex')}`;
    workspaceName = name;
    setEnforce(originalEnforce);
    const error = await backend
      .create(
        integrationSpec(name, [
          {
            env: { POSTGRES_PASSWORD: randomBytes(16).toString('hex') },
            image: 'mirror.gcr.io/library/postgres:18',
            name: 'postgres',
            port: 5432,
          },
        ])
      )
      .then(
        () => new Error('workspace unexpectedly admitted a root-needing service'),
        (err: unknown) => err
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/violates PodSecurity "restricted/i);
    expect((error as Error).message).toMatch(/postgres|runAsNonRoot|runAsUser/i);
  }, 60_000);
});
