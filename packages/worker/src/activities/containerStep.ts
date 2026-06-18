import { randomUUID } from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { assertShellImageAllowed } from '@auto-swe/shared/workflow';
import { runEphemeralContainer } from '../lib/ephemeralContainer.js';
import { execShellAsync } from '../lib/execUtils.js';

/**
 * Container-contract coded step (P4/WS4). Runs `image` in the locked-down
 * ephemeral container (no Docker socket, `--cap-drop=ALL`, read-only root,
 * `--network=none` unless `egress`), passing the resolved node inputs as JSON on
 * the `CONTAINER_STEP_INPUT` env var and parsing the container's stdout as JSON —
 * the result is bound at `nodes.<id>.output.result`. Untrusted code never enters
 * the worker process. Same image allowlist + egress allowlist as `shell`.
 */
export interface ContainerStepInput {
  request: RepoWorkRequest;
  image: string;
  command?: string;
  inputs?: Record<string, unknown>;
  network?: 'none' | 'egress';
  memory?: string;
  cpus?: number;
  timeoutMs?: number;
}

export interface ContainerStepResult {
  result: unknown;
}

export async function runContainerStep(input: ContainerStepInput): Promise<ContainerStepResult> {
  if (!input.command) {
    throw new Error('containerStep requires a command (the sandbox runs `sh -c <command>`)');
  }

  // Team allowlists: a container step is governed exactly like a shell step.
  const conn = await prisma.connection.findUnique({
    include: { team: { select: { egressAllowlist: true, shellImageAllowlist: true } } },
    where: { id: input.request.repoId },
  });
  const imageAllowlist = (conn?.team?.shellImageAllowlist as string[] | null) ?? [];
  const egressAllowlist = (conn?.team?.egressAllowlist as string[] | null) ?? [];
  // Throws ShellImageNotAllowedError if the image isn't on the effective allowlist.
  assertShellImageAllowed(input.image, imageAllowlist);

  // Stateless step → a throwaway empty volume for /workspace (no repo clone).
  const volume = `cstep-${randomUUID()}`;
  await execShellAsync(`docker volume create ${volume}`, {
    heartbeatLabel: 'container-step: volume',
  });
  try {
    const res = await runEphemeralContainer({
      command: input.command,
      cpus: input.cpus,
      egressAllowlist,
      env: { CONTAINER_STEP_INPUT: JSON.stringify(input.inputs ?? {}) },
      image: input.image,
      memory: input.memory,
      network: input.network ?? 'none',
      timeoutMs: input.timeoutMs,
      workspaceMount: volume,
    });
    if (res.exitCode !== 0) {
      throw new Error(
        `containerStep exited ${res.exitCode}: ${(res.stderr || res.stdout || '').slice(0, 2000)}`
      );
    }
    let result: unknown;
    try {
      result = JSON.parse(res.stdout.trim() || 'null');
    } catch {
      throw new Error(
        `containerStep did not emit valid JSON on stdout: ${res.stdout.slice(0, 500)}`
      );
    }
    return { result };
  } finally {
    await execShellAsync(`docker volume rm -f ${volume}`, {
      heartbeatLabel: 'container-step: cleanup',
    }).catch(() => {
      // best-effort cleanup; a leaked empty volume is harmless
    });
  }
}
