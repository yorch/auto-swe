/**
 * The generate → parse → check → repair loop shared by the workflow-authoring activities
 * (`generateWorkflowSpec`, `generateRunPlanSpec`).
 *
 * One model call per round. The model returns `specJson` (a JSON string); the loop parses it
 * (`materializeUses` + `parseWorkflowSpec`) and hands the parsed spec to the caller's `accept`,
 * which returns either errors (fed back for a repair round) or the value to return. The loop
 * itself never decides whether a spec is acceptable: it returns a value only when `accept` did, so
 * a caller's policy cannot be skipped by a loop bug. Bounded by `maxAttempts`.
 */

import { materializeUses, parseWorkflowSpec, type WorkflowSpec } from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { ZodError } from 'zod';
import type { AgentSpec } from '../lib/config/agentSpec.js';
import { runAgent } from './runAgent.js';

export interface AuthorLoopOutput {
  specJson?: string;
  summary?: string;
}

export type AuthorAccept<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export interface AuthorLoopArgs<T> {
  agentSpec: AgentSpec;
  spanName: string;
  maxAttempts: number;
  heartbeatLabel: string;
  initialMessage: string;
  /** The message for a repair round: the errors and the model's own previous `specJson`. */
  buildRepair: (errors: string[], previousSpecJson: string) => string;
  /** Judge a parsed spec. Only an `ok: true` answer ends the loop with a value. */
  accept: (parsed: WorkflowSpec, summary: string) => Promise<AuthorAccept<T>> | AuthorAccept<T>;
}

export type AuthorLoopResult<T> =
  | { ok: true; value: T; attempts: number; summary: string; specJson: string }
  | { ok: false; errors: string[]; attempts: number };

/** Format a thrown validation error into a flat list of human-readable issues. */
export function formatErrors(err: unknown): string[] {
  if (err instanceof ZodError) {
    return err.issues.map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    });
  }
  return [err instanceof Error ? err.message : String(err)];
}

export async function runAuthorLoop<T>(args: AuthorLoopArgs<T>): Promise<AuthorLoopResult<T>> {
  let message = args.initialMessage;
  let lastErrors: string[] = ['model produced no output'];

  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    heartbeat(`${args.heartbeatLabel}: attempt ${attempt}/${args.maxAttempts}`);
    const result = await runAgent<AuthorLoopOutput>(args.agentSpec, message, {
      spanName: args.spanName,
    });

    const specJson = result.object?.specJson;
    const summary = result.object?.summary ?? '';
    if (!specJson) {
      // Tell the model what went wrong rather than re-sending the identical
      // request — a stateless re-issue would just reproduce the same omission.
      lastErrors = [
        'You did not return a non-empty `specJson` field. Return the full ' +
          'WorkflowSpec as a JSON string in the `specJson` field.',
      ];
      message = args.buildRepair(lastErrors, '(no specJson field was returned)');
      continue;
    }

    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(specJson);
    } catch (e) {
      lastErrors = [`specJson is not valid JSON: ${(e as Error).message}`];
      message = args.buildRepair(lastErrors, specJson);
      continue;
    }

    let parsed: WorkflowSpec;
    try {
      // The model may write `uses` instead of (or beside) nodes: expand to the flat form that
      // is stored and run. A MacroUseError is a repairable finding like a schema error.
      parsed = parseWorkflowSpec(materializeUses(parsedUnknown));
    } catch (e) {
      lastErrors = formatErrors(e);
      message = args.buildRepair(lastErrors, specJson);
      continue;
    }

    const verdict = await args.accept(parsed, summary);
    if (verdict.ok) {
      return { attempts: attempt, ok: true, specJson, summary, value: verdict.value };
    }
    lastErrors = verdict.errors;
    message = args.buildRepair(lastErrors, specJson);
  }
  return { attempts: args.maxAttempts, errors: lastErrors, ok: false };
}
