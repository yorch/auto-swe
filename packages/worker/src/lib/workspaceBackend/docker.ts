import { spawn } from 'node:child_process';
import { DOCKER_HOST_ALIAS, resolveWorkspaceInfra } from '@auto-swe/shared/lib/systemConfig';
import {
  type CappedFileResult,
  type CapturedResult,
  execShellAsync,
  spawnCaptureAsync,
  spawnToFileCapped,
  spawnWithStdinAsync,
} from '../execUtils.js';
import { shellQuote } from '../shellQuote.js';
import type {
  EphemeralContainerSpec,
  EphemeralRunOptions,
  HelperContainerSpec,
  WorkspaceBackend,
  WorkspaceContainerSpec,
  WorkspaceExecOptions,
  WorkspaceHandle,
  WorkspaceSpawnOptions,
} from './types.js';

/**
 * Build the `docker run` invocation for the short-lived metadata-block sidecar.
 *
 * Why a sidecar rather than doing this in the workspace container itself: the
 * workspace runs with `--cap-drop=ALL` so it has no `NET_ADMIN` and cannot
 * install routes on its own network stack. Instead, a *separate*, throwaway
 * container joins the workspace's network namespace via `--network
 * container:<containerName>` with `NET_ADMIN` added just long enough to
 * install blackhole routes for the cloud metadata IPs, then exits (`--rm`).
 * The routes live in the shared netns and persist after the sidecar is gone,
 * so the long-lived agent-controlled workspace container never holds
 * `NET_ADMIN` itself.
 *
 * Blocked addresses: `169.254.169.254` (AWS/GCP/Azure IMDS), `169.254.170.2`
 * (ECS task metadata endpoint), `fd00:ec2::254` (IPv6 IMDS). Each `ip route
 * add` is `|| true`'d so a route that already exists (or an `ip -6` on a
 * netns without IPv6) doesn't fail the whole sidecar.
 *
 * Pure and side-effect-free — returns the command string for the caller to
 * exec, so it's unit-testable without a Docker daemon. The route-install
 * behavior itself (does the workspace actually lose IMDS reachability
 * afterward?) still requires a real-Docker smoke test; there is no Docker
 * daemon available in CI or this sandbox to exercise it end-to-end.
 */
export function buildMetadataBlockArgs(containerName: string, image: string): string {
  // Install the IPv4 IMDS blackholes, then VERIFY at least one landed: if the
  // runtime's `ip` applet doesn't support `blackhole` routes, the adds fail
  // silently and this control would otherwise be a no-op with no signal. The
  // final `grep`/`exit 1` makes that case surface as a non-zero exit, which the
  // caller's try/catch logs as a warning instead of a false success. The IPv6
  // add stays soft (a netns without IPv6 legitimately can't add it, and IMDS is
  // IPv4), so it isn't part of the success check.
  const routeCmd = [
    'ip route add blackhole 169.254.169.254/32 2>/dev/null',
    'ip route add blackhole 169.254.170.2/32 2>/dev/null',
    'ip -6 route add blackhole fd00:ec2::254/128 2>/dev/null || true',
    'ip route show 2>/dev/null | grep -q blackhole || ' +
      '{ echo "metadata block: no blackhole route installed (ip may lack blackhole support)" >&2; exit 1; }',
  ].join('; ');
  return `docker run --rm --network container:${containerName} --cap-add=NET_ADMIN -- ${shellQuote(image)} sh -c ${shellQuote(routeCmd)}`;
}

/** The `--add-host` entry that makes the Docker host alias resolve to the host gateway. */
const workerHostEntry = () => `--add-host=${DOCKER_HOST_ALIAS}:host-gateway`;

/**
 * `sh` script that prints the PID of every direct child of PID 1, one per
 * line. Run inside the container immediately after `docker run`, when the
 * only child of `docker-init` is the `sleep infinity` keeper. Uses only
 * `/proc` and `sed`, which busybox and coreutils images both have.
 */
export function keeperPidProbeScript(): string {
  return [
    'asw_ppid() { sed -n \'s/^PPid:[[:space:]]*//p\' "/proc/$1/status" 2>/dev/null; }',
    'for asw_d in /proc/[0-9]*; do',
    '  asw_p=$(basename "$asw_d")',
    '  if [ "$(asw_ppid "$asw_p")" = 1 ]; then echo "$asw_p"; fi',
    'done',
  ].join('\n');
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The names of a `secretEnv`. Each is passed as `-e NAME` without a value, so
 * docker resolves it from the client's own environment and the value is never
 * on a command line. Anything but a plain identifier is refused: `-e A=b`
 * would set a literal value instead, and a name also reaches the shell string
 * of the throwing exec path.
 */
function secretEnvNames(secretEnv: Record<string, string> | undefined): string[] {
  const names = Object.keys(secretEnv ?? {});
  for (const name of names) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`invalid secret environment name: ${JSON.stringify(name)}`);
    }
  }
  return names;
}

/** `-e NAME` for each name of a `secretEnv` (see {@link secretEnvNames}). */
function secretEnvFlags(secretEnv: Record<string, string> | undefined): string[] {
  return secretEnvNames(secretEnv).flatMap((name) => ['-e', name]);
}

/**
 * The `docker exec` argv for one command in the container. A `secretEnv`
 * contributes names only; the caller hands the values to the docker client's
 * environment so `-e NAME` resolves against them.
 */
function execArgv(
  h: WorkspaceHandle,
  argv: string[],
  opts: {
    workdir?: string;
    env?: string[];
    secretEnv?: Record<string, string>;
    stdin?: boolean;
  }
): string[] {
  return [
    'exec',
    ...(opts.stdin ? ['-i'] : []),
    ...(opts.workdir ? ['-w', opts.workdir] : []),
    ...(opts.env ?? []).flatMap((pair) => ['-e', pair]),
    // Named without a value: docker resolves it from the client's environment.
    ...secretEnvFlags(opts.secretEnv),
    h.id,
    ...argv,
  ];
}

/**
 * The same invocation as a shell string, for the throwing exec path
 * (`execShellAsync` semantics). Identifiers the worker generated (container
 * id, env pairs) and the leading argv (`sh -c`) go unquoted as before; the
 * final argument — the script the caller supplied — is shell-quoted.
 */
function execCommand(h: WorkspaceHandle, argv: string[], opts: WorkspaceExecOptions): string {
  const parts = ['docker', 'exec'];
  if (opts.workdir) {
    parts.push('-w', opts.workdir);
  }
  for (const pair of opts.env ?? []) {
    parts.push('-e', pair);
  }
  for (const name of secretEnvNames(opts.secretEnv)) {
    parts.push('-e', shellQuote(name));
  }
  parts.push(h.id, ...argv.slice(0, -1), shellQuote(argv.at(-1) ?? ''));
  return parts.join(' ');
}

/**
 * The Docker driver: workspaces are `docker run`d containers kept alive by
 * `sleep infinity`, reached through `docker exec`, `docker cp` and
 * `docker pause`.
 *
 * Keeper PID: under `--init`, PID 1 is `docker-init` and the keeper is its
 * only child at start — create() records it then, before any exec can spawn
 * siblings that would confuse a later "lowest child of PID 1" guess. A
 * Kubernetes driver cannot reuse the trick (there `sleep` is itself PID 1 in
 * the pod, and the first agent process would look like the keeper — sparing
 * it would leave it alive to read the git credential off the command line),
 * which is why the PID is a creation-time driver output, not a per-call
 * computation.
 */
class DockerWorkspaceBackend implements WorkspaceBackend {
  readonly kind = 'docker' as const;

  async create(spec: WorkspaceContainerSpec): Promise<WorkspaceHandle> {
    // Hardening notes (unlike the locked-down `ephemeralContainer` runner, this
    // workspace intentionally keeps default bridge networking and omits
    // `--read-only`/`--tmpfs`: the implementer agent needs outbound git
    // clone/push + package installs and writes freely to its own container
    // layer for the duration of the run):
    //  - `--memory`/`--cpus`/`--pids-limit` bound a runaway agent-driven build
    //    or test process instead of letting it exhaust the host.
    //  - `--cap-drop=ALL` + `--security-opt=no-new-privileges` remove Linux
    //    capabilities and privilege-escalation the workspace never needs.
    //  - `--add-host` blackholes the *hostname* form of the GCP metadata
    //    endpoint (`metadata.google.internal`/`metadata.gke.internal`) so an
    //    agent can't trivially exfiltrate the host's cloud credentials through
    //    it. This does NOT block the metadata service's link-local IP
    //    (169.254.169.254) directly — an agent could still reach it by IP.
    //    That gap is closed below via a short-lived privileged sidecar (see
    //    `buildMetadataBlockArgs`) run right after this container starts, since
    //    installing the route here would need `NET_ADMIN`, which conflicts
    //    with `--cap-drop=ALL`.
    const dns = spec.dns.map((server) => `--dns=${shellQuote(server)}`).join(' ');
    const addHosts = [
      '--add-host=metadata.google.internal:0.0.0.0',
      '--add-host=metadata.gke.internal:0.0.0.0',
      ...(spec.reachWorker ? [workerHostEntry()] : []),
    ].join(' ');
    const network = spec.network ? ` --network=${shellQuote(spec.network)}` : '';
    // A creation-time secret is named (`-e NAME`) and its value handed to the
    // docker client in its environment, so it is on no command line and in no
    // error text that echoes one.
    const env = [
      ...(spec.env ?? []).map((pair) => ` -e ${shellQuote(pair)}`),
      ...secretEnvNames(spec.secretEnv).map((name) => ` -e ${name}`),
    ].join('');
    // `memory` is a config string, so shell-quote it (the numeric caps can't
    // carry shell metacharacters); '--' separates docker flags from the image.
    await execShellAsync(
      `docker run -d --name ${spec.name} --init ${dns} --memory=${shellQuote(spec.memory)} --cpus=${spec.cpus} --pids-limit=${spec.pidsLimit} --cap-drop=ALL --security-opt=no-new-privileges ${addHosts}${network}${env} -- ${shellQuote(spec.image)} sleep infinity`,
      {
        heartbeatLabel: 'workspace: starting container',
        ...(spec.secretEnv ? { env: spec.secretEnv } : {}),
      }
    );

    // Record the keeper PID now, while the `sleep infinity` under `--init` is
    // provably the only child of PID 1 — before the first exec can leave a
    // sibling behind. Zero or multiple candidates mean the image cannot run
    // the keeper contract (`sleep infinity` under an init) or something raced
    // in, so creation fails closed.
    const probe = await execShellAsync(
      `docker exec ${spec.name} sh -c ${shellQuote(keeperPidProbeScript())}`,
      { heartbeatLabel: 'workspace: identifying keeper process' }
    );
    const candidates = probe
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
    if (candidates.length !== 1) {
      throw new Error(
        `workspace ${spec.name}: expected exactly one keeper process (the child of PID 1), ` +
          `found ${candidates.length} — the image must run \`sleep infinity\` under an init`
      );
    }
    const keeperPid = candidates[0] ?? 0;
    const handle: WorkspaceHandle = { id: spec.name, keeperPid };

    // Cloud metadata-IP egress block: run a throwaway sidecar that shares this
    // container's network namespace to install blackhole routes for the
    // metadata IPs — see `buildMetadataBlockArgs` for the full rationale.
    // Best-effort and non-fatal: a failure here (e.g. an unsupported
    // `--network container:` mode on some Docker runtime) must not break every
    // workspace run, especially since the primary IMDS credential-exfil
    // vector — leaking the *host's* cloud credentials pulled from the metadata
    // service — is already mitigated by the credential scrubbing elsewhere.
    const infra = resolveWorkspaceInfra();
    if (infra.blockMetadata) {
      try {
        await execShellAsync(buildMetadataBlockArgs(spec.name, infra.metadataBlockImage), {
          heartbeatLabel: 'workspace: blocking metadata-IP egress',
        });
      } catch (err) {
        console.warn(
          `workspace ${spec.name}: metadata-IP egress block failed, continuing without it — ` +
            `agent may be able to reach cloud metadata endpoints by IP: ${
              err instanceof Error ? err.message : String(err)
            }`
        );
      }
    }

    return handle;
  }

  attach(id: string, keeperPid = 0): WorkspaceHandle {
    return { id, keeperPid };
  }

  async exec(
    h: WorkspaceHandle,
    argv: string[],
    opts: WorkspaceExecOptions
  ): Promise<CapturedResult> {
    const args = execArgv(h, argv, { ...opts, stdin: opts.stdin !== undefined });
    const runOpts = {
      heartbeatLabel: opts.heartbeatLabel,
      ...(opts.maxOutputBytes !== undefined ? { maxBuffer: opts.maxOutputBytes } : {}),
      onTimeout: opts.onTimeout,
      ...(opts.secretEnv ? { env: opts.secretEnv } : {}),
      timeoutMs: opts.timeoutMs ?? 600_000,
    };
    return opts.stdin !== undefined
      ? spawnWithStdinAsync('docker', args, opts.stdin, runOpts)
      : spawnCaptureAsync('docker', args, runOpts);
  }

  async execShell(h: WorkspaceHandle, argv: string[], opts: WorkspaceExecOptions): Promise<string> {
    return execShellAsync(execCommand(h, argv, opts), {
      heartbeatLabel: opts.heartbeatLabel,
      onTimeout: opts.onTimeout,
      ...(opts.secretEnv ? { env: opts.secretEnv } : {}),
      timeoutMs: opts.timeoutMs,
    });
  }

  spawn(h: WorkspaceHandle, argv: string[], opts: WorkspaceSpawnOptions) {
    const args = [
      'exec',
      ...(opts.stdin ? ['-i'] : []),
      ...(opts.workdir ? ['-w', opts.workdir] : []),
      ...(opts.env ?? []).flatMap((pair) => ['-e', pair]),
      // Named without a value: docker reads it from its own environment below,
      // so a secret never appears on a command line or in `ps`.
      ...secretEnvFlags(opts.secretEnv),
      h.id,
      ...argv,
    ];
    return spawn('docker', args, {
      env: { ...process.env, ...opts.secretEnv },
      signal: opts.signal,
      stdio: opts.stdio,
    });
  }

  copyOut(
    h: WorkspaceHandle,
    path: string,
    destTarFile: string,
    opts?: { maxBytes?: number; timeoutMs?: number; heartbeatLabel?: string }
  ): Promise<CappedFileResult> {
    // The daemon produces the archive, not the container's `tar`. The size cap
    // is enforced while the archive streams to disk: a sparse file expands in
    // full in `docker cp`'s output, so measuring afterwards is too late.
    return spawnToFileCapped('docker', ['cp', `${h.id}:${path}`, '-'], destTarFile, {
      heartbeatLabel: opts?.heartbeatLabel ?? 'workspace: copying out',
      maxBytes: opts?.maxBytes ?? Number.MAX_SAFE_INTEGER,
      timeoutMs: opts?.timeoutMs,
    });
  }

  copyIn(h: WorkspaceHandle, srcTarFile: string, path: string): Promise<void> {
    return execShellAsync(
      `docker cp - ${shellQuote(`${h.id}:${path}`)} < ${shellQuote(srcTarFile)}`,
      { heartbeatLabel: 'workspace: copying in', timeoutMs: 600_000 }
    ).then(() => undefined);
  }

  copyFileIn(
    h: WorkspaceHandle,
    srcFile: string,
    path: string,
    opts?: { timeoutMs?: number; heartbeatLabel?: string }
  ): Promise<CapturedResult> {
    return spawnCaptureAsync('docker', ['cp', srcFile, `${h.id}:${path}`], {
      heartbeatLabel: opts?.heartbeatLabel ?? 'workspace: copying a file in',
      timeoutMs: opts?.timeoutMs ?? 120_000,
    });
  }

  pause(h: WorkspaceHandle): Promise<void> {
    return execShellAsync(`docker pause ${shellQuote(h.id)}`, {
      heartbeatLabel: 'workspace: freezing the container',
      timeoutMs: 30_000,
    }).then(() => undefined);
  }

  async remove(idOrHandle: string | WorkspaceHandle): Promise<void> {
    const id = typeof idOrHandle === 'string' ? idOrHandle : idOrHandle.id;
    try {
      await execShellAsync(`docker rm -f ${id}`);
    } catch {
      /* already gone */
    }
  }

  async createVolume(name: string): Promise<void> {
    await execShellAsync(`docker volume create ${shellQuote(name)}`, {
      heartbeatLabel: 'workspace: creating volume',
    }).then(() => undefined);
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await execShellAsync(`docker volume rm -f ${shellQuote(name)}`);
    } catch {
      /* already gone */
    }
  }

  async runEphemeral(
    spec: EphemeralContainerSpec,
    opts: EphemeralRunOptions
  ): Promise<CapturedResult> {
    return spawnCaptureAsync('docker', ephemeralArgs(spec, false), {
      heartbeatLabel: opts.heartbeatLabel,
      ...(opts.onStdoutLine ? { onStdoutLine: opts.onStdoutLine } : {}),
      timeoutMs: opts.timeoutMs,
    });
  }

  async startDetached(
    spec: EphemeralContainerSpec,
    opts: EphemeralRunOptions
  ): Promise<CapturedResult> {
    return spawnCaptureAsync('docker', ephemeralArgs(spec, true), {
      heartbeatLabel: opts.heartbeatLabel,
      timeoutMs: opts.timeoutMs ?? 60_000,
    });
  }

  async runHelper(spec: HelperContainerSpec, opts: EphemeralRunOptions): Promise<CapturedResult> {
    return spawnCaptureAsync('docker', helperArgs(spec), {
      heartbeatLabel: opts.heartbeatLabel,
      ...(spec.secretEnv ? { env: spec.secretEnv } : {}),
      ...(opts.maxOutputBytes ? { maxBuffer: opts.maxOutputBytes } : {}),
      timeoutMs: opts.timeoutMs,
    });
  }

  canReachWorkerProxy(url: string): boolean {
    return new URL(url).hostname === DOCKER_HOST_ALIAS;
  }

  async sidecarBaseUrl(name: string, containerPort: number): Promise<string> {
    const out = await execShellAsync(`docker port ${shellQuote(name)} ${containerPort}/tcp`, {
      heartbeatLabel: 'workspace: resolving published port',
    });
    const m = /:(\d{1,5})\s*$/m.exec(out.trim());
    if (!m) {
      throw new Error(`could not resolve published port for ${name}:${containerPort}`);
    }
    return `http://127.0.0.1:${Number(m[1])}`;
  }
}

/**
 * `docker run` argv for one platform-authored helper container (the shell
 * step's git clone/finalize), byte-identical to what `shellStep.ts` emitted
 * inline: no lockdown flags, no name and no `--` separator. Author commands
 * never reach this path — they go through `runEphemeral`, which always applies
 * the lockdown.
 */
function helperArgs(spec: HelperContainerSpec): string[] {
  return [
    'run',
    '--rm',
    ...(spec.volumes ?? []).flatMap((v) => [
      '-v',
      `${v.source}:${v.target}:${v.readOnly ? 'ro' : 'rw'}`,
    ]),
    ...(spec.env ?? []).flatMap((pair) => ['-e', pair]),
    ...secretEnvFlags(spec.secretEnv),
    ...(spec.entrypoint ? ['--entrypoint', spec.entrypoint] : []),
    spec.image,
    ...(spec.argv ?? []),
  ];
}

export function ephemeralArgs(spec: EphemeralContainerSpec, detached: boolean): string[] {
  const volumeArgs = (spec.volumes ?? []).flatMap((v) => [
    '-v',
    `${v.source}:${v.target}:${v.readOnly ? 'ro' : 'rw'}`,
  ]);
  const flags = [
    `--network=${spec.network === 'egress' ? 'bridge' : 'none'}`,
    ...(spec.dns ?? []).map((d) => `--dns=${d}`),
    `--memory=${spec.memory ?? '512m'}`,
    `--cpus=${spec.cpus ?? 1}`,
    `--pids-limit=${spec.pidsLimit ?? 256}`,
    '--read-only',
    '--tmpfs=/tmp:size=64m,mode=1777',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    ...(spec.addHosts ?? []).map((h) => `--add-host=${h}`),
    ...(spec.reachWorker ? [workerHostEntry()] : []),
    ...(spec.env ?? []).flatMap((pair) => ['-e', pair]),
    ...volumeArgs,
    ...(spec.workdir ? ['-w', spec.workdir] : []),
  ];
  return [
    'run',
    ...(detached ? ['-d'] : []),
    '--rm',
    ...(spec.name ? ['--name', spec.name] : []),
    ...flags,
    ...(spec.publishPort ? ['-p', `127.0.0.1::${spec.publishPort}/tcp`] : []),
    '--',
    spec.image,
    ...(spec.argv ?? []),
  ];
}

const driver = new DockerWorkspaceBackend();

export function dockerWorkspaceBackend(): WorkspaceBackend {
  return driver;
}
