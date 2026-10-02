/**
 * Explains why an agent run failed, from the error the interpreter recorded on
 * the failed step.
 *
 * The interpreter records `<TYPE>: <message>` for a typed activity failure
 * (`describeStepError`), so this keys on the leading TYPE token and never on the
 * message wording: messages carry text the agent influenced (the push policy
 * lists the changed file paths), and a file named after another error must not
 * change which refusal is reported. Pure and dependency-free so the worker's
 * tests and the dashboard share one definition.
 */

export interface AgentRunFailureView {
  code: string;
  title: string;
  explanation: string;
}

const FAILURES: Record<string, Omit<AgentRunFailureView, 'code'>> = {
  AGENT_NOT_LAUNCHABLE: {
    explanation: 'This agent backs a platform mechanism and cannot be launched as an agent run.',
    title: 'Agent cannot be launched',
  },
  AGENT_RUN_CONCURRENCY_EXCEEDED: {
    explanation:
      'Too many agent runs were in flight when this one started. Re-run when one finishes.',
    title: 'Concurrency limit reached',
  },
  AGENT_RUN_DIFF_TOO_LARGE: {
    explanation:
      'The change is too large for the security gate to read in one pass, or its diff could not be read, and a partial scan would not be a scan. Ask for a smaller change.',
    title: 'Change too large to check',
  },
  AGENT_RUN_EXPORT_TOO_LARGE: {
    explanation:
      'The working tree is too large to copy out of the sandbox. Keep dependency and build output in ignored paths.',
    title: 'Working tree too large',
  },
  AGENT_RUN_PUSH_POLICY: {
    explanation:
      'The change touches something an agent run may never publish (a sensitive file, a binary, a symlink or submodule, an oversized file, or a workflow file). Nothing was pushed, including the files that were allowed.',
    title: 'Refused by the push policy',
  },
  AGENT_RUNS_DISABLED: {
    explanation: 'Agent runs are switched off for this team or the platform.',
    title: 'Agent runs are disabled',
  },
  BUDGET_EXCEEDED: {
    explanation:
      'The run reached its budget and stopped. Use a larger budget tier or a narrower task.',
    title: 'Budget exhausted',
  },
  DRAFT_PR_UNSUPPORTED: {
    explanation:
      'The branch was pushed, but this repository cannot hold draft pull requests, so none was opened (a ready-for-review one is never opened instead). Open a pull request from the branch yourself, or re-run with "Push a branch".',
    title: 'Draft pull requests are not supported here',
  },
  MODEL_UNPRICED: {
    explanation:
      "The model this agent is bound to has no price in the model catalog, and a monthly USD budget applies, so its spend could not be counted. Nothing ran. Add the model's price in the model catalog (or bind a priced model), then re-run.",
    title: 'Model has no price',
  },
  PR_CREATE_FAILED: {
    explanation:
      'The branch was pushed, but opening the pull request failed. The branch is still there.',
    title: 'Pull request could not be opened',
  },
  SECURITY_GATE_FAILURE: {
    explanation:
      'The security gate found a critical issue in the change. Nothing was pushed and no pull request was opened.',
    title: 'Blocked by the security gate',
  },
  SECURITY_GATE_UNAVAILABLE: {
    explanation:
      'The security gate could not run, so the change was not published. A gate that cannot say the change is clean never lets it through. Re-run to try again.',
    title: 'Security gate unavailable',
  },
};

const TYPE_PREFIX = /^([A-Z][A-Z0-9_]*): /;

/** `null` when the error carries no recognised type; the generic failure card still shows it. */
export function classifyAgentRunFailure(
  error: string | null | undefined
): AgentRunFailureView | null {
  const code = error ? TYPE_PREFIX.exec(error)?.[1] : undefined;
  const known = code ? FAILURES[code] : undefined;
  return code && known ? { code, ...known } : null;
}
