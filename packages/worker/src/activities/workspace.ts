import { execSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { DOCKER_IMAGE_REF_RE } from '@auto-swe/shared/workflow';
import { type CapturedResult, EXEC_OPTS, parseSpawnSyncResult } from '../lib/execUtils.js';

export type CapturedExec = CapturedResult;

export interface Workspace {
  containerId: string;
  exec: (command: string) => string;
  /**
   * Run a command and capture stdout/stderr/exitCode without throwing on
   * non-zero exits. Used by quality-gate activities that interpret exit
   * code themselves rather than relying on exec's throw-on-error semantics.
   */
  execCapture: (command: string, options?: { timeoutMs?: number }) => CapturedExec;
  destroy: () => void;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function createWorkspace(
  repoUrl: string,
  branch: string,
  defaultBranch: string,
  githubToken: string,
  image: string = 'node:24-alpine'
): Workspace {
  if (!DOCKER_IMAGE_REF_RE.test(image)) {
    throw new Error(`Invalid Docker image name: ${image}`);
  }

  const id = crypto.randomBytes(8).toString('hex');
  const containerName = `workspace-${id}`;

  const authedUrl = repoUrl.replace('https://', `https://x-access-token:${githubToken}@`);

  // Start container — use '--' to separate docker flags from the image argument
  execSync(
    `docker run -d --name ${containerName} -- ${shellQuote(image)} sleep infinity`,
    EXEC_OPTS
  );

  // Initial exec function (root of container)
  const rootExec = (command: string): string =>
    execSync(`docker exec ${containerName} sh -c ${shellQuote(command)}`, EXEC_OPTS) as string;

  // Wrap provisioning in try/catch — destroy the container if any setup step fails
  // to prevent accumulation of orphaned containers on repeated failures.
  try {
    // Install git if not present (alpine images may not have it)
    rootExec('which git || apk add --no-cache git');

    // Configure git identity — required for commits in ephemeral containers.
    // Without this, `git commit` fails with "Author identity unknown".
    rootExec("git config --global user.name 'auto-swe'");
    rootExec("git config --global user.email 'auto-swe@localhost'");

    // Clone repo — shell-quote branch names to prevent injection
    rootExec(
      `git clone --depth=50 -b ${shellQuote(defaultBranch)} ${shellQuote(authedUrl)} /workspace/target-repo`
    );
    rootExec(`cd /workspace/target-repo && git checkout -b ${shellQuote(branch)}`);
  } catch (err) {
    try {
      execSync(`docker rm -f ${containerName}`, EXEC_OPTS);
    } catch {
      /* already gone */
    }
    throw err;
  }

  return {
    containerId: containerName,
    destroy: () => {
      try {
        execSync(`docker rm -f ${containerName}`, EXEC_OPTS);
      } catch {
        // Container may already be gone
      }
    },
    exec: (command: string) =>
      execSync(
        `docker exec -w /workspace/target-repo ${containerName} sh -c ${shellQuote(command)}`,
        EXEC_OPTS
      ) as string,
    execCapture: (command: string, options) => {
      const timeoutMs = options?.timeoutMs ?? 600_000;
      const result = spawnSync(
        'docker',
        ['exec', '-w', '/workspace/target-repo', containerName, 'sh', '-c', command],
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }
      );
      return parseSpawnSyncResult(result);
    },
  };
}
