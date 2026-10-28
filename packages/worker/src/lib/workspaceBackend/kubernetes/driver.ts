import { type StdioOptions, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import {
  DOCKER_HOST_ALIAS,
  type KubernetesWorkspaceConfig,
  resolveWorkspaceInfra,
} from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { logWarn } from '../../activityLog.js';
import {
  type CappedFileResult,
  type CapturedResult,
  execShellAsync,
  spawnCaptureAsync,
  spawnToFileCapped,
  spawnWithStdinAsync,
} from '../../execUtils.js';
import { shellQuote } from '../../shellQuote.js';
import { keeperPidProbeScript } from '../docker.js';
import type {
  EphemeralContainerSpec,
  EphemeralRunOptions,
  HelperContainerSpec,
  WorkspaceBackend,
  WorkspaceContainerSpec,
  WorkspaceExecOptions,
  WorkspaceHandle,
  WorkspaceSpawnOptions,
} from '../types.js';
import {
  deletePodArgs,
  execArgs,
  execPrefix,
  type PodRef,
  secretStdinPreamble,
  tarOutArgs,
  waitRunningArgs,
} from './kubectlArgs.js';
import { buildWorkspacePod } from './podSpec.js';
import { assertSafeArchive } from './safeTar.js';

/** `kubectl exec` prints this after a command that exited non-zero; it is noise, not the command's stderr. */
const TERMINATED_LINE = /^command terminated with exit code \d+\s*$/m;
const stripTerminated = (stderr: string): string => stderr.replace(TERMINATED_LINE, '').trimEnd();

/** How long a new pod has to become Ready (image pull included). */
const READY_TIMEOUT_SEC = 300;

const UNSUPPORTED =
  'is not supported by the Kubernetes workspace backend yet: shell steps, container steps and ' +
  'sidecars need volumes shared between containers. Run them on a worker with ' +
  'WORKSPACE_BACKEND=docker.';

/** A rejected promise, not a throw: these methods are async, and a caller may build the promise before awaiting it. */
function unsupported(what: string): Promise<never> {
  return Promise.reject(
    ApplicationFailure.nonRetryable(`${what} ${UNSUPPORTED}`, 'WORKSPACE_BACKEND_UNSUPPORTED')
  );
}

/** Shell-string form of a `kubectl` invocation, for the paths that redirect a file into or out of it. */
function shellCommand(bin: string, args: string[]): string {
  return [bin, ...args].map((a) => shellQuote(a)).join(' ');
}

/** Run a shell command and report it the way `exec` does, never throwing on a non-zero exit. */
async function captured(
  command: string,
  opts: { timeoutMs: number; heartbeatLabel: string }
): Promise<CapturedResult> {
  try {
    const stdout = await execShellAsync(command, opts);
    return { exitCode: 0, stderr: '', stdout };
  } catch (err) {
    const e = err as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stderr: typeof e.stderr === 'string' ? e.stderr : String(e.message ?? err),
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
    };
  }
}

/**
 * The Kubernetes driver: a workspace is a Pod kept alive by `sleep infinity`,
 * reached through `kubectl exec`.
 *
 * `kubectl` rather than a client library so `spawn()` returns a real
 * `ChildProcess` (the harness depends on its stream and exit semantics) and so
 * in-cluster and kubeconfig authentication work unchanged.
 *
 * The workspace's blast radius is the pod spec (`buildWorkspacePod`) plus the
 * namespace's NetworkPolicy, which the deployment applies; this driver cannot
 * add the egress block itself (no `NET_ADMIN` under PodSecurity `restricted`),
 * which is why `assertNetworkPolicyEnforced` runs at worker start.
 */
export class KubernetesWorkspaceBackend implements WorkspaceBackend {
  readonly kind = 'kubernetes' as const;

  constructor(private readonly config: () => KubernetesWorkspaceConfig) {}

  private ref(h: WorkspaceHandle | string): PodRef {
    return {
      namespace: this.config().namespace,
      pod: typeof h === 'string' ? h : h.id,
    };
  }

  private get kubectl(): string {
    return this.config().kubectl;
  }

  async create(spec: WorkspaceContainerSpec): Promise<WorkspaceHandle> {
    const config = this.config();
    const created = await spawnWithStdinAsync(
      this.kubectl,
      ['create', '--namespace', config.namespace, '-f', '-'],
      JSON.stringify(buildWorkspacePod(spec, config)),
      { heartbeatLabel: 'workspace: creating pod', timeoutMs: 60_000 }
    );
    if (created.exitCode !== 0) {
      throw new Error(`workspace ${spec.name}: could not create the pod: ${created.stderr}`);
    }
    const ref = this.ref(spec.name);
    const ready = await spawnCaptureAsync(this.kubectl, waitRunningArgs(ref, READY_TIMEOUT_SEC), {
      heartbeatLabel: 'workspace: waiting for the pod',
      timeoutMs: (READY_TIMEOUT_SEC + 15) * 1000,
    });
    if (ready.exitCode !== 0) {
      throw new Error(`workspace ${spec.name}: the pod did not become ready: ${ready.stderr}`);
    }

    // Record the keeper PID now, while `sleep` is provably the only child of
    // the pod's PID 1 (`shareProcessNamespace` makes that the `pause` process,
    // which reaps orphans like Docker's `--init`), before any exec leaves a
    // sibling behind. Zero or several candidates fail creation closed.
    const probe = await this.exec(this.attach(spec.name), ['sh', '-c', keeperPidProbeScript()], {
      heartbeatLabel: 'workspace: identifying keeper process',
      timeoutMs: 30_000,
    });
    const candidates = probe.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
    if (probe.exitCode !== 0 || candidates.length !== 1) {
      throw new Error(
        `workspace ${spec.name}: expected exactly one keeper process (the child of PID 1), ` +
          `found ${candidates.length} — the image must run \`sleep infinity\` ` +
          `(probe exit ${probe.exitCode}: ${probe.stderr.slice(0, 200)})`
      );
    }
    return { id: spec.name, keeperPid: candidates[0] ?? 0 };
  }

  attach(id: string, keeperPid = 0): WorkspaceHandle {
    return { id, keeperPid };
  }

  async exec(
    h: WorkspaceHandle,
    argv: string[],
    opts: WorkspaceExecOptions
  ): Promise<CapturedResult> {
    const stdin = opts.stdin !== undefined;
    const args = execArgs(this.ref(h), argv, {
      env: opts.env,
      interactive: stdin,
      workdir: opts.workdir,
    });
    const runOpts = {
      heartbeatLabel: opts.heartbeatLabel,
      ...(opts.maxOutputBytes !== undefined ? { maxBuffer: opts.maxOutputBytes } : {}),
      onTimeout: opts.onTimeout,
      timeoutMs: opts.timeoutMs ?? 600_000,
    };
    const result = stdin
      ? await spawnWithStdinAsync(this.kubectl, args, opts.stdin as string | Buffer, runOpts)
      : await spawnCaptureAsync(this.kubectl, args, runOpts);
    return { ...result, stderr: stripTerminated(result.stderr) };
  }

  async execShell(h: WorkspaceHandle, argv: string[], opts: WorkspaceExecOptions): Promise<string> {
    const result = await this.exec(h, argv, opts);
    if (result.exitCode !== 0) {
      // The shape `execShellAsync` rejects with, so callers' error handling is unchanged.
      throw Object.assign(
        new Error(`Command failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`),
        { code: result.exitCode, stderr: result.stderr, stdout: result.stdout }
      );
    }
    return result.stdout;
  }

  spawn(h: WorkspaceHandle, argv: string[], opts: WorkspaceSpawnOptions) {
    const secrets = opts.secretEnv ?? {};
    const hasSecrets = Object.keys(secrets).length > 0;
    const args = execArgs(this.ref(h), argv, {
      env: opts.env,
      interactive: opts.stdin,
      secrets: hasSecrets,
      workdir: opts.workdir,
    });
    // The preamble is written to stdin, so stdin must be a pipe whatever the
    // caller asked for; it is closed again below when the caller wants none.
    const stdio: StdioOptions = hasSecrets
      ? ['pipe', ...(Array.isArray(opts.stdio) ? opts.stdio.slice(1, 3) : [opts.stdio, opts.stdio])]
      : opts.stdio;
    const child = spawn(this.kubectl, args, { env: process.env, signal: opts.signal, stdio });
    if (hasSecrets && child.stdin) {
      // A kubectl that dies early closes the pipe; that is the exit event's to report.
      child.stdin.on('error', () => undefined);
      child.stdin.write(secretStdinPreamble(secrets));
      if (!opts.stdin) {
        child.stdin.end();
      }
    }
    return child;
  }

  copyOut(
    h: WorkspaceHandle,
    path: string,
    destTarFile: string,
    opts?: { maxBytes?: number; timeoutMs?: number; heartbeatLabel?: string }
  ): Promise<CappedFileResult> {
    // The pod's own `tar` produces the archive (there is no daemon to do it),
    // so the stream is as untrusted as the agent that could have replaced the
    // binary; `copyIn` into the trusted pod validates it before extraction.
    // The size cap is enforced while streaming, as under Docker.
    return spawnToFileCapped(
      this.kubectl,
      [...execPrefix(this.ref(h), false), ...tarOutArgs(path)],
      destTarFile,
      {
        heartbeatLabel: opts?.heartbeatLabel ?? 'workspace: copying out',
        maxBytes: opts?.maxBytes ?? Number.MAX_SAFE_INTEGER,
        timeoutMs: opts?.timeoutMs,
      }
    );
  }

  async copyIn(h: WorkspaceHandle, srcTarFile: string, path: string): Promise<void> {
    await assertSafeArchive(srcTarFile);
    const args = [...execPrefix(this.ref(h), true), 'tar', 'xf', '-', '-C', path];
    await execShellAsync(`${shellCommand(this.kubectl, args)} < ${shellQuote(srcTarFile)}`, {
      heartbeatLabel: 'workspace: copying in',
      timeoutMs: 600_000,
    });
  }

  async copyFileIn(
    h: WorkspaceHandle,
    srcFile: string,
    path: string,
    opts?: { timeoutMs?: number; heartbeatLabel?: string }
  ): Promise<CapturedResult> {
    // `docker cp` keeps the file's mode and the harness binary must stay
    // executable, so carry the mode across and move the file into place
    // whole (a half-written binary must never be at its final path).
    const mode = ((await fs.stat(srcFile)).mode & 0o777).toString(8);
    const script =
      'umask 022; mkdir -p "$(dirname "$0")" && cat > "$0.asw-tmp" && ' +
      'chmod "$1" "$0.asw-tmp" && mv -f "$0.asw-tmp" "$0"';
    const args = [...execPrefix(this.ref(h), true), 'sh', '-c', script, path, mode];
    const result = await captured(`${shellCommand(this.kubectl, args)} < ${shellQuote(srcFile)}`, {
      heartbeatLabel: opts?.heartbeatLabel ?? 'workspace: copying a file in',
      timeoutMs: opts?.timeoutMs ?? 120_000,
    });
    return { ...result, stderr: stripTerminated(result.stderr) };
  }

  async pause(h: WorkspaceHandle): Promise<void> {
    // No freezer is reachable from inside a pod. SIGSTOP to every process the
    // exec user may signal (all but PID 1 and the signalling shell) cannot be
    // caught or ignored, which is the part of `docker pause` the caller needs:
    // a quiescent tree to copy.
    const result = await this.exec(h, ['sh', '-c', 'kill -STOP -1'], {
      heartbeatLabel: 'workspace: freezing the pod',
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`could not freeze the workspace: ${result.stderr}`);
    }
  }

  async remove(idOrHandle: string | WorkspaceHandle): Promise<void> {
    try {
      const result = await spawnCaptureAsync(this.kubectl, deletePodArgs(this.ref(idOrHandle)), {
        heartbeatLabel: 'workspace: removing pod',
        timeoutMs: 60_000,
      });
      // `--ignore-not-found` makes a missing pod a success, so a non-zero exit is a real failure
      // (API error, RBAC): the pod would otherwise live to its deadline, holding quota.
      if (result.exitCode !== 0) {
        logWarn('kubernetes workspace pod could not be removed', {
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 500),
        });
      }
    } catch {
      /* already gone */
    }
  }

  createVolume(_name: string): Promise<void> {
    return unsupported('A shared workspace volume');
  }

  removeVolume(_name: string): Promise<void> {
    return Promise.resolve();
  }

  runEphemeral(_spec: EphemeralContainerSpec, _opts: EphemeralRunOptions): Promise<CapturedResult> {
    return unsupported('An ephemeral sandbox container');
  }

  startDetached(
    _spec: EphemeralContainerSpec,
    _opts: EphemeralRunOptions
  ): Promise<CapturedResult> {
    return unsupported('A detached sidecar container');
  }

  runHelper(_spec: HelperContainerSpec, _opts: EphemeralRunOptions): Promise<CapturedResult> {
    return unsupported('A platform helper container');
  }

  sidecarBaseUrl(_name: string, _containerPort: number): Promise<string> {
    return unsupported('A sidecar');
  }

  /**
   * Whether a pod can resolve the proxy's host: anything but the Docker host
   * alias, which exists only on a Docker host. Reachability proper is the
   * NetworkPolicy's and the Service's business.
   */
  canReachWorkerProxy(url: string): boolean {
    return new URL(url).hostname !== DOCKER_HOST_ALIAS;
  }
}

let driver: KubernetesWorkspaceBackend | undefined;

export function kubernetesWorkspaceBackend(): WorkspaceBackend {
  driver ??= new KubernetesWorkspaceBackend(() => resolveWorkspaceInfra().kubernetes);
  return driver;
}
