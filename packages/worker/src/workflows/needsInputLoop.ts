/**
 * The workflow's ask-and-resume loop: run an activity that may stop to ask a person,
 * turn each stop into a human step, wait for the answer and run the same activity
 * again with it.
 *
 * Isolate-safe: only `import type` from outside the workflow packages. The dispatcher
 * hands in the human-step and signal primitives it already has, which keeps this file
 * free of Temporal state and its tests free of a Temporal server.
 */

import type { ResumeInput } from '@auto-swe/shared/lib/needsInput';
import type { NeedsInputLimits } from '@auto-swe/shared/lib/needsInputAsk';
import { ApplicationFailure } from '@temporalio/common';
import { buildAskStep, isPauseResult, mapAskAnswers } from '../lib/workflowEngine.js';

/** The fields the loop adds to a pausable activity's input. */
export interface PauseArgs {
  /** False only on the one last run at the round limit, which must finish without asking. */
  allowPause: boolean;
  resumeInput?: ResumeInput;
}

/** The marker that gates all of the loop: executions that started before it replay without. */
export const NEEDS_INPUT_PATCH = 'needs-input-v1';
/** Gates re-asking after an answer that fits no question, instead of failing the step. */
export const NEEDS_INPUT_REASK_PATCH = 'needs-input-reask-v1';
/** Gates the one last unattended run at the round limit, instead of discarding that round's work. */
export const NEEDS_INPUT_FINAL_PATCH = 'needs-input-final-round-v1';
/** Gates closing the open question's human step when the wait for its answer is cancelled. */
export const NEEDS_INPUT_CANCEL_PATCH = 'needs-input-cancel-v1';

/** The most times one round is put to the person again after an answer that cannot be used. */
export const MAX_REASKS_PER_ROUND = 3;

export interface AskDeps {
  createHumanStep(args: {
    context: string;
    description: string;
    fields: Array<{
      key: string;
      label: string;
      options?: string[];
      required?: boolean;
      type: string;
    }>;
    kind: 'INPUT';
    nodeId: string;
    signalName: string;
    timeout: string;
    title: string;
  }): Promise<void>;
  isCancellation(err: unknown): boolean;
  patched(id: string): boolean;
  resolveHumanStep(args: { nodeId: string; status: 'CANCELLED' | 'TIMED_OUT' }): Promise<void>;
  /** Run `fn` in a scope that a cancellation of the surrounding one cannot interrupt. */
  runNonCancellable(fn: () => Promise<void>): Promise<void>;
  /** The payload, or `undefined` once `timeout` has passed. */
  waitSignal(name: string, timeout: string): Promise<unknown | undefined>;
}

/** The human step's id and signal for the `round`-th question of the dispatch `key`. */
export function askRecordingId(key: string, round: number): string {
  return `${key}:ask:${round}`;
}

/** The human step id of the `n`-th repeat (1-based) of round `round`'s question. */
export function reaskRecordingId(key: string, round: number, n: number): string {
  return `${askRecordingId(key, round)}.${n}`;
}

/**
 * Run `invoke` until it returns a result that is not a pause.
 *
 * Every question round gets its own recording id, derived from the dispatch key and
 * the round number only, so a replayed or retried dispatch names the same human step
 * and signal each time and the step is never created twice for one round. A timeout
 * fails the step with `NEEDS_INPUT_TIMEOUT`, more than `limits.maxRounds` pauses with
 * `NEEDS_INPUT_LIMIT`, a malformed pause with `NEEDS_INPUT_MALFORMED` and an answer that does not fit the questions with
 * `NEEDS_INPUT_INVALID_ANSWER` — all non-retryable, because a retry would only ask the
 * person again. A cancellation, from the wait or the activity, is not caught.
 */
export async function runWithNeedsInput(args: {
  deps: AskDeps;
  invoke(pause: PauseArgs): Promise<unknown>;
  /** The dispatch key, with the interpreter attempt when it is not the first. */
  key: string;
  /** What to call the asker in the human step's title: the agent key or the node title. */
  label: string;
  limits: NeedsInputLimits;
}): Promise<unknown> {
  const { deps, key, label, limits } = args;
  const timeout = `${limits.timeoutSeconds}s`;
  let pause: PauseArgs = { allowPause: true };
  let finalResumed = false;
  for (let round = 1; ; round++) {
    const result = await args.invoke(pause);
    if (!isPauseResult(result)) {
      // A result that claims to be a pause and is not one must not travel on as an ordinary
      // result; the activity validates what it returns, so this is a defect, not a retry.
      if (typeof result === 'object' && result !== null && 'needsInput' in result) {
        throw ApplicationFailure.nonRetryable(
          `${label} returned a malformed request for input.`,
          'NEEDS_INPUT_MALFORMED'
        );
      }
      return result;
    }
    if (round > limits.maxRounds) {
      // The last round's work is kept: the activity runs once more, unable to ask, and
      // told to finish on its own judgement. A second pause after that is the limit.
      if (!finalResumed && deps.patched(NEEDS_INPUT_FINAL_PATCH)) {
        finalResumed = true;
        pause = {
          allowPause: false,
          resumeInput: { answers: [], final: true, resume: result.needsInput.resume, round },
        };
        continue;
      }
      throw ApplicationFailure.nonRetryable(
        `${label} asked for input more than ${limits.maxRounds} times; giving up.`,
        'NEEDS_INPUT_LIMIT'
      );
    }
    const { needsInput } = result;
    const ask = buildAskStep(needsInput);
    let nodeId = askRecordingId(key, round);
    let description = ask.description;
    let reasks = 0;
    let mapped: ReturnType<typeof mapAskAnswers>;
    for (;;) {
      const signalName = `hitl_${nodeId}`;
      let payload: unknown;
      try {
        await deps.createHumanStep({
          context: ask.context,
          description,
          fields: ask.fields,
          kind: 'INPUT',
          nodeId,
          signalName,
          timeout,
          title: `${label} needs input`.slice(0, 200),
        });
        payload = await deps.waitSignal(signalName, timeout);
      } catch (err) {
        // The wait was cancelled (a fan-out sibling failed, or the run was): nobody is going
        // to read this question, so it leaves the inbox now instead of when the run ends.
        if (deps.isCancellation(err) && deps.patched(NEEDS_INPUT_CANCEL_PATCH)) {
          await deps.runNonCancellable(() =>
            deps.resolveHumanStep({ nodeId, status: 'CANCELLED' }).catch(() => {})
          );
        }
        throw err;
      }
      if (payload === undefined) {
        await deps.resolveHumanStep({ nodeId, status: 'TIMED_OUT' });
        throw ApplicationFailure.nonRetryable(
          `${label} waited ${limits.timeoutSeconds} seconds for an answer and got none.`,
          'NEEDS_INPUT_TIMEOUT'
        );
      }
      mapped = mapAskAnswers(needsInput.questions, payload);
      if (mapped.ok) {
        break;
      }
      if (reasks >= MAX_REASKS_PER_ROUND || !deps.patched(NEEDS_INPUT_REASK_PATCH)) {
        throw ApplicationFailure.nonRetryable(
          `The answer to ${label}'s question was not usable: ${mapped.reason}.`,
          'NEEDS_INPUT_INVALID_ANSWER'
        );
      }
      // The same round, the same questions, a step of its own: the round is not used up and
      // the activity does not run again.
      reasks += 1;
      nodeId = reaskRecordingId(key, round, reasks);
      description = `Your previous answer could not be used (${mapped.reason.slice(0, 200)}). Please answer again.\n\n${ask.description}`;
    }
    pause = {
      allowPause: true,
      resumeInput: { answers: mapped.answers, resume: needsInput.resume, round },
    };
  }
}
