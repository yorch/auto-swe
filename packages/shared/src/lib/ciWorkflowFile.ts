/**
 * Reading a GitHub Actions workflow file for the steps that failed. Separate from `ciTrigger`,
 * which the dashboard imports, so the YAML parser stays out of the browser bundle.
 */
import { parse as parseYaml } from 'yaml';
/** Each line trimmed, blank lines dropped: a `run:` block's indentation is not the command. */
export function normaliseRunCommand(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join('\n');
}

/** A failed job as the host reports it: its display name and the steps that failed. */
export interface FailedJobSteps {
  name: string;
  failedSteps: string[];
}

/**
 * The `run:` bodies of the steps that failed, read from the workflow file: a step counts when
 * its job is one of the failed jobs (by display name, a matrix suffix such as `test (18)`
 * allowed) and its own display name is one of that job's failed steps. An unnamed step shows as
 * `Run <its first line>`, as GitHub names it. Normalised with {@link normaliseRunCommand}; empty
 * when the file does not parse or names no such step.
 */
export function failingStepRuns(workflowFile: string, failedJobs: FailedJobSteps[]): string[] {
  let doc: unknown;
  try {
    doc = parseYaml(workflowFile);
  } catch {
    return [];
  }
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  if (!jobs || typeof jobs !== 'object') {
    return [];
  }
  const runs: string[] = [];
  for (const [key, raw] of Object.entries(jobs as Record<string, unknown>)) {
    const job = raw as { name?: unknown; steps?: unknown } | null;
    const jobName = typeof job?.name === 'string' ? job.name : key;
    const failed = failedJobs.filter(
      (j) => j.name === jobName || j.name.startsWith(`${jobName} (`)
    );
    if (failed.length === 0 || !Array.isArray(job?.steps)) {
      continue;
    }
    const failedSteps = new Set(failed.flatMap((j) => j.failedSteps));
    for (const step of job.steps as Array<{ name?: unknown; run?: unknown } | null>) {
      if (typeof step?.run !== 'string') {
        continue;
      }
      const run = normaliseRunCommand(step.run);
      const display = typeof step.name === 'string' ? step.name : `Run ${run.split('\n')[0] ?? ''}`;
      if (run.length > 0 && failedSteps.has(display)) {
        runs.push(run);
      }
    }
  }
  return runs;
}
