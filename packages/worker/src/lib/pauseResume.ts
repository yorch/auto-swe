import {
  isNeedsInput,
  MAX_NEEDS_INPUT_CHARS,
  type NeedsInput,
  type NeedsInputQuestion,
  type ResumeInput,
  ResumeInputSchema,
  type ResumeState,
} from '@auto-swe/shared/lib/needsInput';
import { ApplicationFailure } from '@temporalio/activity';
import { z } from 'zod';
import type { Workspace } from '../activities/workspace.js';
import { currentWorkflowRunId } from './activityContext.js';
import type { AgentTracer } from './agentTracer.js';
import {
  buildDigest,
  buildResumePrompt,
  restoreWorkingTree,
  snapshotWorkingTree,
} from './pauseSnapshot.js';
import { shellQuote } from './shellQuote.js';

/**
 * The activity-side half of ask-and-resume, shared by the four surfaces that can
 * pause (an agent node's checkout, an agent run, the implementer's TDD loop and
 * the fix sessions): save the tree and return the questions, or validate the
 * state the workflow hands back and put the tree back before the first turn.
 */

/** What an activity returns instead of its result when its agent needs a person. */
export interface NeedsInputResult {
  needsInput: NeedsInput;
}

/** The fields the workflow's ask-and-resume loop adds to an activity's input. */
export interface PauseOptions {
  /** The run can stop to ask a person. Absent, the agent runs unattended. */
  allowPause?: boolean;
  /** The saved state and the person's answers, when this is the run after a pause. */
  resumeInput?: ResumeInput;
}

export type PauseSurface =
  | 'executeImplementation'
  | 'implementerSession'
  | 'runAgentNode'
  | 'runAgentTask';

/** The most characters of a test run's output a TDD pause keeps. */
export const MAX_PAUSED_TEST_OUTPUT_CHARS = 4000;

/**
 * `{ allowPause: true }` for a run that may pause on a runtime that can: only
 * Claude Code offers a question tool, so any other runtime stays unattended.
 */
export function pausable(allowPause: boolean | undefined, runtime: string): { allowPause?: true } {
  return allowPause && runtime === 'claude-code' ? { allowPause: true } : {};
}

const restoreFailed = (message: string) =>
  ApplicationFailure.nonRetryable(message, 'NEEDS_INPUT_RESTORE_FAILED');

/**
 * The commit a resumed run's workspace is cut from: the one its saved working tree
 * is a patch against, so the patch applies however far the base branch has moved
 * while the person decided. Undefined for a first run and for a clean tree (nothing
 * to apply), which both start from the branch tip as usual.
 */
export function resumeCheckoutSha(resume: ResumeInput | undefined): string | undefined {
  return resume?.resume.snapshot?.baseSha;
}

/** What the rounds before a resume already used of a run's step and wall-clock caps. */
export interface CarriedUsage {
  elapsedMs: number;
  steps: number;
}

const nonNegative = z.number().finite().nonnegative().optional().catch(undefined);
const CarriedUsageSchema = z.looseObject({ usedElapsedMs: nonNegative, usedSteps: nonNegative });

/**
 * The step and wall-clock usage a surface saved in its state (`usedSteps`, `usedElapsedMs`).
 * Zero for a first run and for a state without them (written before they existed, or a
 * foreign one), so an old state keeps working and merely starts counting afresh.
 */
export function carriedUsage(resume: ResumeInput | undefined): CarriedUsage {
  const parsed = CarriedUsageSchema.safeParse(resume?.resume.surface);
  return {
    elapsedMs: parsed.success ? (parsed.data.usedElapsedMs ?? 0) : 0,
    steps: parsed.success ? Math.floor(parsed.data.usedSteps ?? 0) : 0,
  };
}

/** `raw` as a {@link ResumeInput}, or a non-retryable `NEEDS_INPUT_RESTORE_FAILED`. */
export function readResumeInput(raw: unknown): ResumeInput {
  const parsed = ResumeInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw restoreFailed('The saved state to resume from is not valid.');
  }
  return parsed.data;
}

/**
 * Check a resume state against the activity that is resuming: it must have been
 * written by the same surface, for the same agent and branch. Anything else is a
 * state from another run or another step, refused non-retryably.
 */
export function checkSurfaceState(
  resume: ResumeState,
  expect: { agentKey: string; branch: string; kind: PauseSurface }
): void {
  const base = z
    .looseObject({ agentKey: z.string(), branch: z.string(), kind: z.string() })
    .safeParse(resume.surface);
  if (
    !base.success ||
    base.data.kind !== expect.kind ||
    base.data.agentKey !== expect.agentKey ||
    base.data.branch !== expect.branch
  ) {
    throw restoreFailed('The saved state belongs to a different step, agent or branch.');
  }
}

/** {@link checkSurfaceState}, then the fields `extra` names, which the surface needs to continue. */
export function readSurfaceState<T extends z.ZodType>(
  resume: ResumeState,
  expect: { agentKey: string; branch: string; kind: PauseSurface },
  extra: T
): z.infer<T> {
  checkSurfaceState(resume, expect);
  const parsed = extra.safeParse(resume.surface);
  if (!parsed.success) {
    throw restoreFailed('The saved state is missing what this step needs to continue.');
  }
  return parsed.data;
}

/**
 * The credential a clone URL embeds, as the strings to mask by value: the token, the
 * `git -c http.extraheader` line built from it and that line's base64 part. Empty
 * for a URL without one or one that does not parse.
 */
export function cloneCredentialSecrets(authedCloneUrl: string): string[] {
  try {
    const raw = new URL(authedCloneUrl).password;
    if (!raw) {
      return [];
    }
    let token = raw;
    try {
      token = decodeURIComponent(raw);
    } catch {
      // Undecodable: the verbatim text is what the clone used.
    }
    const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
    return [token, `AUTHORIZATION: basic ${encoded}`, encoded];
  } catch {
    return [];
  }
}

/**
 * Stop at a question: save the working tree, summarise the work so far and build
 * the result the workflow turns into a human step. Nothing is committed, pushed
 * or scanned. Throws a non-retryable `NEEDS_INPUT_SNAPSHOT_TOO_LARGE` when the tree
 * does not fit, and `NEEDS_INPUT_TOO_LARGE` when the saved state itself does not.
 */
export async function pauseForInput(args: {
  lastText?: string;
  questions: NeedsInputQuestion[];
  /** Credentials to mask by value in the digest, besides the ones shaped like one. */
  secrets?: ReadonlyArray<string | null | undefined>;
  /** The commit the checkout was at before the agent ran: what the tree is saved against. */
  startSha: string;
  state: { agentKey: string; branch: string } & Record<string, unknown>;
  surface: PauseSurface;
  tracer: AgentTracer;
  workspace: Workspace;
}): Promise<NeedsInputResult> {
  const { snapshot } = await snapshotWorkingTree(args.workspace, {
    runId: await currentWorkflowRunId(),
    startSha: args.startSha,
  });
  // The snapshot staged everything, so the index names exactly what changed.
  const touchedFiles = snapshot
    ? (
        await args.workspace
          .exec(`git diff --cached --name-only ${shellQuote(args.startSha)}`)
          .catch(() => '')
      )
        .split('\n')
        .filter(Boolean)
    : [];
  const result: NeedsInputResult = {
    needsInput: {
      questions: args.questions,
      resume: {
        asked: args.questions.map((q) => ({ header: q.header, question: q.question })),
        digest: buildDigest({ lastText: args.lastText, secrets: args.secrets, touchedFiles }),
        snapshot,
        surface: { ...args.state, kind: args.surface },
        version: 1,
      },
    },
  };
  if (!isNeedsInput(result)) {
    throw ApplicationFailure.nonRetryable(
      `The questions and saved state are too large to hand to a person (over ${MAX_NEEDS_INPUT_CHARS} characters).`,
      'NEEDS_INPUT_TOO_LARGE'
    );
  }
  args.tracer.addActivityEvent({
    name: 'agent.paused',
    outputJson: {
      questions: args.questions.length,
      snapshotBytes: snapshot?.bytes ?? 0,
      surface: args.surface,
    },
  });
  return result;
}

/**
 * Put the paused run's working tree back on this fresh checkout, before the first
 * turn. Throws a non-retryable `NEEDS_INPUT_RESTORE_FAILED` when it cannot.
 */
export async function restoreForResume(args: {
  resume: ResumeInput;
  surface: PauseSurface;
  tracer: AgentTracer;
  workspace: Workspace;
}): Promise<void> {
  await restoreWorkingTree(args.workspace, args.resume.resume.snapshot);
  args.tracer.addActivityEvent({
    name: 'agent.resumed',
    outputJson: {
      round: args.resume.round,
      snapshotBytes: args.resume.resume.snapshot?.bytes ?? 0,
      surface: args.surface,
    },
  });
}

/** The first message of the resumed session: `task`, then the questions, the answers and the digest. */
export function resumeMessage(resume: ResumeInput, task: string): string {
  return buildResumePrompt({
    answers: resume.answers,
    asked: resume.resume.asked,
    digest: resume.resume.digest,
    ...(resume.final ? { final: true } : {}),
    task,
  });
}
