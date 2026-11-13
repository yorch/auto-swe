import { randomUUID } from 'node:crypto';
import { prisma } from '@auto-swe/shared/db';
import { executorImageFor } from '@auto-swe/shared/lib/executorImage';
import { RepoOnboardingDraftSchema } from '@auto-swe/shared/lib/onboardingPr';
import {
  type SetupBlocker,
  SetupBlockerSchema,
  setupBlockerRemedy,
} from '@auto-swe/shared/lib/setupBlocker';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { PreviewNotReadyError, startAppPreview } from '../lib/appPreview.js';
import { throwIfActivityCancelled } from '../lib/cancellation.js';
import { withHeartbeat } from '../lib/execUtils.js';
import { failedStepBlocker, WORKSPACE_SETUP_FAILED } from '../lib/repoSetupRun.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { captureWorkspaceCommand, workspaceLogTail } from '../lib/workspaceCommand.js';
import { createWorkspace, type Workspace } from './workspace.js';

export interface RepoOnboardingTrialInput {
  connectionId: string;
  draft: unknown;
}
export interface RepoOnboardingTrialItem {
  kind: 'setup' | 'gate' | 'preview';
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode?: number;
  logTail?: string;
  error?: string;
}
export interface RepoOnboardingTrialResult {
  trialPassed: boolean;
  repairable: boolean;
  items: RepoOnboardingTrialItem[];
  blockers: SetupBlocker[];
  markdown: string;
}

const OPERATOR_ONLY = new Set<SetupBlocker['kind']>([
  'missing_secret',
  'secret_decrypt_failed',
  'egress_denied',
  'git_auth',
  'git_fetch',
  'lfs_missing',
  'internal',
]);
const GATE_TIMEOUT_MS = 600_000;

export async function repoOnboardingTrial(
  input: RepoOnboardingTrialInput
): Promise<RepoOnboardingTrialResult> {
  const parsed = RepoOnboardingDraftSchema.safeParse(input.draft);
  if (!parsed.success) {
    throw ApplicationFailure.nonRetryable(
      'The onboarding draft is invalid.',
      'ONBOARDING_TRIAL_REFUSED'
    );
  }
  return withHeartbeat('repository onboarding trial', runTrial(input.connectionId, parsed.data));
}

async function runTrial(
  connectionId: string,
  draft: ReturnType<typeof RepoOnboardingDraftSchema.parse>
): Promise<RepoOnboardingTrialResult> {
  const items: RepoOnboardingTrialItem[] = [
    { kind: 'setup', name: 'Workspace setup', status: 'skipped' },
  ];
  const gates = Object.entries(draft.gateCommands).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0
  );
  items.push(
    ...Object.keys(draft.gateCommands).map((name) => ({
      kind: 'gate' as const,
      name,
      status: 'skipped' as const,
    }))
  );
  const previewItem: RepoOnboardingTrialItem | undefined = draft.previewConfig
    ? { kind: 'preview', name: 'Preview readiness', status: 'skipped' }
    : undefined;
  if (previewItem) {
    items.push(previewItem);
  }
  const blockers: SetupBlocker[] = [];
  let workspace: Workspace | undefined;
  let preview: Awaited<ReturnType<typeof startAppPreview>> | undefined;
  const redact = (text: string, limit = 4000) => workspaceLogTail(workspace, text, limit);
  const fail = async (
    item: RepoOnboardingTrialItem,
    error: unknown,
    started: number,
    kind: SetupBlocker['kind']
  ) => {
    item.status = 'failed';
    item.error = redact(error instanceof Error ? error.message : String(error));
    const failure = error as { type?: unknown; details?: unknown } | null;
    const typed =
      failure?.type === WORKSPACE_SETUP_FAILED && Array.isArray(failure.details)
        ? failure.details.flatMap((detail) => {
            const result = SetupBlockerSchema.safeParse(detail);
            return result.success ? [result.data] : [];
          })
        : [];
    const fallback: SetupBlocker = { detail: redact(item.error, 2000), kind, subject: item.name };
    const candidates = typed.length ? typed : [fallback];
    const denied = await failedStepBlocker(started, candidates[0] ?? fallback);
    if (
      denied.kind === 'egress_denied' &&
      !candidates.some((blocker) => blocker.kind === 'egress_denied')
    ) {
      candidates.push(denied);
    }
    blockers.push(
      ...candidates.map((blocker) => ({
        ...blocker,
        subject: redact(blocker.subject, 1000),
        ...(blocker.step ? { step: redact(blocker.step, 1000) } : {}),
        detail: redact(blocker.detail, 2000),
      }))
    );
  };
  const setupItem = items[0];
  if (!setupItem) {
    throw new Error('Missing setup trial item');
  }
  let started = Date.now();
  try {
    try {
      heartbeat('onboarding trial: provisioning and setup');
      const repo = await prisma.connection.findUniqueOrThrow({
        include: { installation: { select: { host: true, installationId: true } } },
        where: { id: connectionId },
      });
      const ref = toRepoRef(repo);
      const { authedCloneUrl } = await getScmProvider(ref).cloneCredentials(ref);
      workspace = await createWorkspace(
        authedCloneUrl,
        `auto/onboarding-trial-${randomUUID()}`,
        repo.defaultBranch,
        executorImageFor(repo),
        undefined,
        undefined,
        {
          detectedStack: repo.detectedStack,
          inheritSetupEgress: true,
          repoSetup: {
            // The draft is written by an agent from repository content and runs before a human
            // approves it, so it never receives a team secret.
            allowTeamSecrets: false,
            connectionId,
            defer: true,
            field: draft.setup,
            recordBlockers: false,
          },
          services: draft.previewConfig?.services,
          teamId: repo.teamId,
          toolsFor: { connectionId },
        }
      );
      await workspace.runSetup?.();
      await workspace.finishSetup?.();
      setupItem.status = 'passed';
    } catch (error) {
      throwIfActivityCancelled();
      await fail(setupItem, error, started, 'internal');
    }
    if (setupItem.status === 'passed' && workspace) {
      for (const [name, command] of gates) {
        throwIfActivityCancelled();
        const item = items.find((entry) => entry.kind === 'gate' && entry.name === name);
        if (!item) {
          continue;
        }
        started = Date.now();
        heartbeat(`onboarding trial: ${name}`);
        try {
          const result = await captureWorkspaceCommand(workspace, command, GATE_TIMEOUT_MS);
          item.exitCode = result.exitCode;
          item.logTail = result.logTail;
          item.status = result.exitCode === 0 && !result.signal ? 'passed' : 'failed';
          if (item.status === 'failed') {
            await fail(
              item,
              new Error(result.logTail || `${name} failed (exit ${result.exitCode})`),
              started,
              result.signal ? 'step_timeout' : 'step_failed'
            );
          }
        } catch (error) {
          throwIfActivityCancelled();
          await fail(item, error, started, 'internal');
        }
      }
      if (draft.previewConfig && previewItem) {
        throwIfActivityCancelled();
        started = Date.now();
        heartbeat('onboarding trial: preview readiness');
        try {
          preview = await startAppPreview(workspace, draft.previewConfig, {
            allowTeamSecrets: false,
            connectionId,
          });
          previewItem.status = 'passed';
          previewItem.logTail = redact(await preview.logTail(4000));
        } catch (error) {
          throwIfActivityCancelled();
          if (error instanceof PreviewNotReadyError) {
            previewItem.logTail = redact(error.logTail);
          }
          await fail(
            previewItem,
            error,
            started,
            error instanceof PreviewNotReadyError ? 'step_failed' : 'internal'
          );
        }
      }
    }
  } finally {
    for (const cleanup of [() => preview?.stop(), () => workspace?.destroy()]) {
      try {
        await cleanup();
      } catch (error) {
        const item: RepoOnboardingTrialItem = {
          kind: 'setup',
          name: 'Trial cleanup',
          status: 'failed',
        };
        items.push(item);
        await fail(item, error, Date.now(), 'internal');
      }
    }
  }
  const trialPassed = !items.some((item) => item.status === 'failed');
  const repairable = !trialPassed && !blockers.some((blocker) => OPERATOR_ONLY.has(blocker.kind));
  const markdown = [
    '## Repository onboarding trial',
    '',
    trialPassed
      ? 'Trial passed.'
      : repairable
        ? 'Trial failed; the draft can be repaired.'
        : 'Trial blocked; operator action is required.',
    '',
    ...items.flatMap((item) => [
      `- **${item.status}** — ${item.kind}: ${redact(item.name, 1000)}${item.exitCode === undefined ? '' : ` (exit ${item.exitCode})`}`,
      ...[item.error, item.logTail]
        .filter((text): text is string => !!text)
        .map((text) =>
          text
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n')
        ),
    ]),
    '',
    ...blockers.map(
      (blocker) =>
        `- **${blocker.kind}**: ${setupBlockerRemedy(blocker)}${blocker.subject ? ` (${blocker.subject})` : ''}`
    ),
  ].join('\n');
  return { blockers, items, markdown, repairable, trialPassed };
}
