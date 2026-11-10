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
  allowPause: true;
  resumeInput?: ResumeInput;
}

/** The marker that gates all of the loop: executions that started before it replay without. */
export const NEEDS_INPUT_PATCH = 'needs-input-v1';

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
  resolveHumanStep(args: { nodeId: string; status: 'TIMED_OUT' }): Promise<void>;
  /** The payload, or `undefined` once `timeout` has passed. */
  waitSignal(name: string, timeout: string): Promise<unknown | undefined>;
}

/** The human step's id and signal for the `round`-th question of the dispatch `key`. */
export function askRecordingId(key: string, round: number): string {
  return `${key}:ask:${round}`;
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
      throw ApplicationFailure.nonRetryable(
        `${label} asked for input more than ${limits.maxRounds} times; giving up.`,
        'NEEDS_INPUT_LIMIT'
      );
    }
    const { needsInput } = result;
    const ask = buildAskStep(needsInput);
    const nodeId = askRecordingId(key, round);
    const signalName = `hitl_${nodeId}`;
    await deps.createHumanStep({
      context: ask.context,
      description: ask.description,
      fields: ask.fields,
      kind: 'INPUT',
      nodeId,
      signalName,
      timeout,
      title: `${label} needs input`.slice(0, 200),
    });
    const payload = await deps.waitSignal(signalName, timeout);
    if (payload === undefined) {
      await deps.resolveHumanStep({ nodeId, status: 'TIMED_OUT' });
      throw ApplicationFailure.nonRetryable(
        `${label} waited ${limits.timeoutSeconds} seconds for an answer and got none.`,
        'NEEDS_INPUT_TIMEOUT'
      );
    }
    const mapped = mapAskAnswers(needsInput.questions, payload);
    if (!mapped.ok) {
      throw ApplicationFailure.nonRetryable(
        `The answer to ${label}'s question was not usable: ${mapped.reason}.`,
        'NEEDS_INPUT_INVALID_ANSWER'
      );
    }
    pause = {
      allowPause: true,
      resumeInput: { answers: mapped.answers, resume: needsInput.resume, round },
    };
  }
}
