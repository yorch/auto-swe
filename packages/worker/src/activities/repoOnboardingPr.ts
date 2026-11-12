import {
  type OnboardingRequest,
  RepoOnboardingDraftSchema,
  renderOnboardingFiles,
} from '@auto-swe/shared/lib/onboardingPr';
import type { OnboardingPrResult } from '@auto-swe/shared/lib/onboardingPrWorkflow';
import { ApplicationFailure } from '@temporalio/activity';
import { currentRunLauncherId } from '../lib/runLauncher.js';
import { contentHashOf, openOnboardingPr } from './openOnboardingPr.js';

export interface RepoOnboardingPrInput {
  connectionId: string;
  draft: unknown;
}

export async function repoOnboardingPr(input: RepoOnboardingPrInput): Promise<OnboardingPrResult> {
  const parsed = RepoOnboardingDraftSchema.safeParse(input.draft);
  if (!parsed.success) {
    throw ApplicationFailure.nonRetryable(
      'The onboarding draft is invalid.',
      'ONBOARDING_PR_REFUSED'
    );
  }
  const proposedById = await currentRunLauncherId();
  if (!proposedById) {
    throw ApplicationFailure.nonRetryable(
      'Onboarding delivery requires a verified run launcher.',
      'ONBOARDING_PR_REFUSED'
    );
  }
  const draft = parsed.data;
  const files: OnboardingRequest['files'] = [
    { kind: 'setup', setup: draft.setup },
    { gateCommands: draft.gateCommands, kind: 'gates' },
    ...(draft.previewConfig
      ? [{ kind: 'preview' as const, previewConfig: draft.previewConfig }]
      : []),
  ];
  let rendered: ReturnType<typeof renderOnboardingFiles>;
  try {
    rendered = renderOnboardingFiles({ files });
  } catch {
    throw ApplicationFailure.nonRetryable(
      'The onboarding draft cannot be rendered.',
      'ONBOARDING_PR_REFUSED'
    );
  }
  return openOnboardingPr({
    connectionId: input.connectionId,
    contentHash: contentHashOf(rendered),
    files,
    proposedById,
  });
}
