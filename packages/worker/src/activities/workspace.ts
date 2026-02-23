import { execSync, type ExecSyncOptions } from 'node:child_process';
import crypto from 'node:crypto';

export interface Workspace {
  containerId: string;
  exec: (command: string) => string;
  destroy: () => void;
}

const EXEC_OPTS: ExecSyncOptions = {
  encoding: 'utf-8' as BufferEncoding,
  timeout: 120_000, // 2 minutes per command
  maxBuffer: 10 * 1024 * 1024, // 10MB
};

export function createWorkspace(
  repoUrl: string,
  branch: string,
  defaultBranch: string,
  githubToken: string,
  image: string = 'node:24-alpine',
): Workspace {
  const id = crypto.randomBytes(8).toString('hex');
  const containerName = `workspace-${id}`;

  const authedUrl = repoUrl.replace(
    'https://',
    `https://x-access-token:${githubToken}@`,
  );

  // Start container with git installed
  execSync(
    `docker run -d --name ${containerName} ${image} sleep infinity`,
    EXEC_OPTS,
  );

  // Initial exec function (root of container)
  const rootExec = (command: string): string => {
    return execSync(
      `docker exec ${containerName} sh -c '${command.replace(/'/g, "'\\''")}'`,
      EXEC_OPTS,
    ) as string;
  };

  // Install git if not present (alpine images may not have it)
  rootExec('which git || apk add --no-cache git');

  // Configure git identity — required for commits in ephemeral containers.
  // Without this, `git commit` fails with "Author identity unknown".
  rootExec("git config --global user.name 'auto-swe'");
  rootExec("git config --global user.email 'auto-swe@localhost'");

  // Clone repo
  rootExec(`git clone --depth=50 -b ${defaultBranch} '${authedUrl}' /workspace/target-repo`);
  rootExec(`cd /workspace/target-repo && git checkout -b '${branch}'`);

  return {
    containerId: containerName,
    exec: (command: string) => {
      return execSync(
        `docker exec -w /workspace/target-repo ${containerName} sh -c '${command.replace(/'/g, "'\\''")}'`,
        EXEC_OPTS,
      ) as string;
    },
    destroy: () => {
      try {
        execSync(`docker rm -f ${containerName}`, EXEC_OPTS);
      } catch {
        // Container may already be gone
      }
    },
  };
}
