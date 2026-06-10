import crypto from 'node:crypto';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { type CapturedResult, execShellAsync, spawnCaptureAsync } from '../lib/execUtils.js';

export type CapturedExec = CapturedResult;

export interface Workspace {
  containerId: string;
  exec: (command: string) => Promise<string>;
  /**
   * Run a command and capture stdout/stderr/exitCode without throwing on
   * non-zero exits. Used by quality-gate activities that interpret exit
   * code themselves rather than relying on exec's throw-on-error semantics.
   */
  execCapture: (command: string, options?: { timeoutMs?: number }) => Promise<CapturedExec>;
  destroy: () => Promise<void>;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Provision an ephemeral Docker workspace with the repo cloned at the default
 * branch and a fresh local branch checked out. `authedRepoUrl` must already
 * carry credentials — callers obtain it from
 * `ScmProvider.cloneCredentials().authedCloneUrl` (lib/scm), which keeps the
 * provider-specific credential embedding out of this file. All execs are
 * async (the old execSync versions blocked the worker event loop, starving
 * Temporal heartbeats for every concurrent activity) and pump heartbeats
 * while the child process runs.
 */
export async function createWorkspace(
  authedRepoUrl: string,
  branch: string,
  defaultBranch: string,
  image: string = 'node:24-alpine'
): Promise<Workspace> {
  if (!DOCKER_IMAGE_REF_RE.test(image)) {
    throw new Error(`Invalid Docker image name: ${image}`);
  }

  const id = crypto.randomBytes(8).toString('hex');
  const containerName = `workspace-${id}`;

  // Start container — use '--' to separate docker flags from the image argument
  await execShellAsync(
    `docker run -d --name ${containerName} -- ${shellQuote(image)} sleep infinity`,
    { heartbeatLabel: 'workspace: starting container' }
  );

  // Initial exec function (root of container)
  const rootExec = (command: string): Promise<string> =>
    execShellAsync(`docker exec ${containerName} sh -c ${shellQuote(command)}`, {
      heartbeatLabel: 'workspace: provisioning',
    });

  // Wrap provisioning in try/catch — destroy the container if any setup step fails
  // to prevent accumulation of orphaned containers on repeated failures.
  try {
    // Install git if not present (alpine images may not have it)
    await rootExec('which git || apk add --no-cache git');

    // Configure git identity — required for commits in ephemeral containers.
    // Without this, `git commit` fails with "Author identity unknown".
    await rootExec("git config --global user.name 'auto-swe'");
    await rootExec("git config --global user.email 'auto-swe@localhost'");

    // Clone repo — shell-quote branch names to prevent injection
    await rootExec(
      `git clone --depth=50 -b ${shellQuote(defaultBranch)} ${shellQuote(authedRepoUrl)} /workspace/target-repo`
    );
    await rootExec(`cd /workspace/target-repo && git checkout -b ${shellQuote(branch)}`);
  } catch (err) {
    try {
      await execShellAsync(`docker rm -f ${containerName}`);
    } catch {
      /* already gone */
    }
    throw err;
  }

  return {
    containerId: containerName,
    destroy: async () => {
      try {
        await execShellAsync(`docker rm -f ${containerName}`);
      } catch {
        // Container may already be gone
      }
    },
    exec: (command: string) =>
      execShellAsync(
        `docker exec -w /workspace/target-repo ${containerName} sh -c ${shellQuote(command)}`,
        { heartbeatLabel: 'workspace: exec' }
      ),
    execCapture: (command: string, options) =>
      spawnCaptureAsync(
        'docker',
        ['exec', '-w', '/workspace/target-repo', containerName, 'sh', '-c', command],
        { heartbeatLabel: 'workspace: exec (capture)', timeoutMs: options?.timeoutMs ?? 600_000 }
      ),
  };
}
