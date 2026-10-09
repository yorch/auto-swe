/**
 * Automations: everything that starts template runs without a person pressing run
 * (docs/automations.md). One contract — WHEN (an event source and its filters, a cron, a
 * secret URL, a tracker status), WHAT (a template and its inputs), LIMITS, and one decision
 * ledger — over every kind.
 *
 * Event sources are pure descriptors: the gateway decides with them, the dashboard renders
 * their filters and tests a would-be occurrence with the same `mismatch` the webhook uses.
 * Adding a source is a descriptor plus a webhook normalizer.
 */
import { WORKFLOW_RUN_FAILED, workflowRunFailedSource } from './sources/workflowRunFailed.js';
import type { EventSource } from './types.js';

export * from './inputs.js';
export * from './sources/workflowRunFailed.js';
export * from './types.js';

/** Every event source, by the key an automation stores. */
export const EVENT_SOURCES = {
  [WORKFLOW_RUN_FAILED]: workflowRunFailedSource,
} as const;

export type EventSourceKey = keyof typeof EVENT_SOURCES;
export const EVENT_SOURCE_KEYS = Object.keys(EVENT_SOURCES) as EventSourceKey[];

/** The source an automation names, or null for one this build does not know. */
export function eventSource(key: string): EventSource<unknown, unknown> | null {
  return Object.hasOwn(EVENT_SOURCES, key)
    ? (EVENT_SOURCES[key as EventSourceKey] as unknown as EventSource<unknown, unknown>)
    : null;
}
