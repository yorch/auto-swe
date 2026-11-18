import type { RepoOnboardingDraft } from '@auto-swe/shared/lib/onboardingPr';

/**
 * Tools an onboarding trial workspace cannot be assumed to have: container and cluster clients and
 * vendor CLIs. A setup step that merely checks for one of them must not fail the trial when the
 * workspace lacks it. Tools the setup steps actually run (node, yarn, python, ...) are deliberately
 * absent: a missing one is a real failure the person reviewing the draft needs to see.
 */
export const OPTIONAL_WORKSPACE_TOOLS: ReadonlySet<string> = new Set([
  'aws',
  'az',
  'docker',
  'docker-compose',
  'gcloud',
  'helm',
  'kind',
  'kubectl',
  'minikube',
  'podman',
  'snyk',
  'terraform',
]);

/** A line that does nothing but test whether one tool exists, with no fallback of its own. */
const BARE_PRESENCE_CHECK =
  /^(\s*)((?:command\s+-v|which|type|hash)\s+([A-Za-z0-9._-]+))(\s*>\s*\/dev\/null(?:\s*2>&1)?)?\s*$/;

/**
 * Make bare `command -v <tool>` lines for tools the workspace may lack print a warning instead of
 * failing. Lines with their own fallback (`|| true`), a pipeline or a chained command are left
 * alone, as are checks for any tool outside {@link OPTIONAL_WORKSPACE_TOOLS}.
 */
export function relaxOptionalToolChecks(run: string): string {
  return run
    .split('\n')
    .map((line) => {
      const match = BARE_PRESENCE_CHECK.exec(line);
      const tool = match?.[3];
      if (!match || !tool || !OPTIONAL_WORKSPACE_TOOLS.has(tool)) {
        return line;
      }
      const [, indent, check, , quiet = ''] = match;
      return `${indent}${check}${quiet} || echo "warning: ${tool} not found in this workspace; continuing"`;
    })
    .join('\n');
}

/** The draft with every setup step's optional-tool presence checks made non-fatal. */
export function relaxDraftToolChecks(draft: RepoOnboardingDraft): RepoOnboardingDraft {
  if (!draft.setup.steps?.length) {
    return draft;
  }
  return {
    ...draft,
    setup: {
      ...draft.setup,
      steps: draft.setup.steps.map((step) => ({ ...step, run: relaxOptionalToolChecks(step.run) })),
    },
  };
}
