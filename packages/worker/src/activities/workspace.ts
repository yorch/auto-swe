import { type ExecSyncOptions, execSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

export interface CapturedExec {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Set when the command did not exit cleanly (timeout, signal, spawn error). */
  signal?: string;
}

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

const EXEC_OPTS: ExecSyncOptions = {
  encoding: 'utf-8' as BufferEncoding,
  maxBuffer: 10 * 1024 * 1024, // 10MB
  timeout: 120_000, // 2 minutes per command
};

// Validate Docker image names to prevent shell injection.
// Allows standard image refs: registry/org/name:tag@sha256:digest
const DOCKER_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]*$/;

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
  if (!DOCKER_IMAGE_RE.test(image)) {
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
  const rootExec = (command: string): string => {
    return execSync(
      `docker exec ${containerName} sh -c ${shellQuote(command)}`,
      EXEC_OPTS
    ) as string;
  };

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
    exec: (command: string) => {
      return execSync(
        `docker exec -w /workspace/target-repo ${containerName} sh -c ${shellQuote(command)}`,
        EXEC_OPTS
      ) as string;
    },
    execCapture: (command: string, options) => {
      const timeoutMs = options?.timeoutMs ?? 600_000; // 10 min default for gate runs
      const result = spawnSync(
        'docker',
        ['exec', '-w', '/workspace/target-repo', containerName, 'sh', '-c', command],
        {
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: timeoutMs,
        }
      );
      // spawnSync sets `status` to the exit code (or null on signal/timeout),
      // and `error` on spawn failure. We normalize to a non-throwing shape.
      return {
        exitCode: typeof result.status === 'number' ? result.status : 124,
        stderr: result.stderr ?? '',
        stdout: result.stdout ?? '',
        ...(result.signal ? { signal: result.signal } : {}),
      };
    },
  };
}
