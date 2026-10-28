import { MANAGED_BY_LABEL, WORKSPACE_CONTAINER, WORKSPACE_ROLE_LABEL } from './podSpec.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The shell run in the pod for every exec. `$0` is the working directory;
 * everything after it is the command. When the exec carries secrets, the
 * wrapper first reads `NAME=value` lines from stdin up to a blank line and
 * exports them, then `exec`s the command with the rest of stdin intact.
 *
 * Why stdin and not argv or a file: a `kubectl exec` command line is an
 * apiserver URL (so it lands in audit logs) and in the worker's own process
 * table. A value read from stdin is in neither, and unlike a file in the pod it
 * never exists anywhere another process could open it. `read` consumes a pipe
 * one byte at a time, so nothing past the blank line is swallowed.
 */
const PLAIN_WRAPPER = 'cd "$0" && exec "$@"';
const SECRET_WRAPPER =
  'cd "$0" && while IFS= read -r asw_l && [ -n "$asw_l" ]; do export "$asw_l"; done; exec "$@"';

export interface PodRef {
  namespace: string;
  pod: string;
}

/** `kubectl exec` up to and including the `--` that precedes the command. */
export function execPrefix(ref: PodRef, interactive: boolean): string[] {
  return [
    'exec',
    ...(interactive ? ['-i'] : []),
    '--namespace',
    ref.namespace,
    '--container',
    WORKSPACE_CONTAINER,
    ref.pod,
    '--',
  ];
}

/**
 * The full `kubectl` argv to run `argv` in the pod. `env` pairs are non-secret
 * and travel as `env NAME=value` in the command; `secretNames` only decides
 * whether the secret-reading wrapper is used (the values go on stdin, see
 * {@link secretStdinPreamble}).
 */
export function execArgs(
  ref: PodRef,
  argv: string[],
  opts: { workdir?: string; env?: string[]; interactive?: boolean; secrets?: boolean }
): string[] {
  const env = opts.env ?? [];
  return [
    ...execPrefix(ref, Boolean(opts.interactive || opts.secrets)),
    'sh',
    '-c',
    opts.secrets ? SECRET_WRAPPER : PLAIN_WRAPPER,
    opts.workdir ?? '/',
    ...(env.length > 0 ? ['env', ...env] : []),
    ...argv,
  ];
}

/**
 * What the worker writes to the exec's stdin before the command's own input:
 * one `NAME=value` line per secret and a terminating blank line. A name that is
 * not a plain identifier, or a value that would end the line early, is refused —
 * the wrapper has no way to carry either safely.
 */
export function secretStdinPreamble(secrets: Record<string, string>): string {
  let out = '';
  for (const [name, value] of Object.entries(secrets)) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`invalid secret environment name: ${name}`);
    }
    if (value === '' || /[\r\n\0]/.test(value)) {
      throw new Error(`secret ${name} cannot be delivered: empty or contains a line break`);
    }
    out += `${name}=${value}\n`;
  }
  return `${out}\n`;
}

/** `kubectl` argv for the pod operations that take no command. */
export function getPodArgs(ref: PodRef): string[] {
  return ['get', 'pod', ref.pod, '--namespace', ref.namespace, '--ignore-not-found', '-o', 'json'];
}

/** Every pod in the namespace that carries both workspace marker labels. */
export function listWorkspacePodsArgs(namespace: string): string[] {
  return [
    'get',
    'pods',
    '--namespace',
    namespace,
    '--selector',
    `${MANAGED_BY_LABEL}=auto-swe,${WORKSPACE_ROLE_LABEL}=workspace`,
    '-o',
    'json',
  ];
}

export function deletePodArgs(ref: PodRef): string[] {
  return [
    'delete',
    'pod',
    ref.pod,
    '--namespace',
    ref.namespace,
    '--ignore-not-found',
    '--wait=false',
    '--grace-period=0',
    '--force',
  ];
}

/** Waits until the pod is Ready; it has no probes, so that means its container is running. */
export function waitRunningArgs(ref: PodRef, timeoutSec: number): string[] {
  return [
    'wait',
    '--for=condition=Ready',
    `pod/${ref.pod}`,
    '--namespace',
    ref.namespace,
    `--timeout=${timeoutSec}s`,
  ];
}

/** The tar command that exports `path`; a trailing `/.` means "the contents", as `docker cp` reads it. */
export function tarOutArgs(path: string): string[] {
  const contents = path.endsWith('/.');
  const dir = contents ? path.slice(0, -2) || '/' : path.slice(0, path.lastIndexOf('/')) || '/';
  const entry = contents ? '.' : path.slice(path.lastIndexOf('/') + 1);
  return ['tar', 'cf', '-', '-C', dir, entry];
}
