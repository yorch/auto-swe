import { putArtifact } from '@auto-swe/shared/lib/artifactStore';
import { currentWorkflowRunId, persistActivityTrace } from './activityContext.js';
import { AgentTracer, redactJsonValues } from './agentTracer.js';
import { maskCredentialShapes } from './redactToken.js';

function redactOutput(text: string): string {
  try {
    return maskCredentialShapes(JSON.stringify(redactJsonValues(JSON.parse(text))));
  } catch {
    return redactLines(text);
  }
}

function redactLines(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      try {
        return maskCredentialShapes(JSON.stringify(redactJsonValues(JSON.parse(line))));
      } catch {
        return maskCredentialShapes(line);
      }
    })
    .join('\n');
}

export async function executionAudit(args: {
  name: 'shell' | 'container';
  image: string;
  command?: string;
  network: string;
  egressAllowlist: string[];
  stdout: string;
  stderr: string;
  exitCode?: number;
  durationMs: number;
  artifactId?: string;
  error?: string;
}): Promise<void> {
  try {
    const artifactId =
      args.artifactId ??
      (
        await putArtifact({
          body: JSON.stringify({
            stderr: redactOutput(args.stderr),
            stdout: redactOutput(args.stdout),
          }),
          contentType: 'application/json',
          kind: `${args.name}.step`,
          runId: await currentWorkflowRunId(),
        }).catch(() => undefined)
      )?.id;
    const tracer = new AgentTracer();
    tracer.addActivityEvent({
      durationMs: args.durationMs,
      error: args.error ? maskCredentialShapes(args.error) : undefined,
      inputJson: {
        command: maskCredentialShapes(args.command ?? ''),
        egressAllowlist: args.egressAllowlist,
        image: args.image,
        network: args.network,
      },
      name: `${args.name}.exec`,
      outputJson: { artifactId, exitCode: args.exitCode },
    });
    await persistActivityTrace(tracer, 'execution');
  } catch {
    /* Audit persistence must not change the command outcome. */
  }
}
