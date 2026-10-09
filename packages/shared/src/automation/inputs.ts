import { z } from 'zod';
import { type InputSchema, isInputSchema, validateInputPayload } from '../lib/inputSchema.js';
import type { EventSource } from './types.js';

const MAX_INPUTS_JSON = 4_000;

/** Payload keys every occurrence fills, whatever its source: never an automation's option. */
const ALWAYS_FILLED = ['connectionId', 'description', 'ticketId'] as const;

/**
 * An automation's options as the API accepts them: a flat object of template inputs, no null
 * values (a null skips the template's validation of its key), and small. Which keys are
 * allowed, and whether the values fit, is `buildAutomationPayload`'s question.
 */
export const AutomationInputsSchema = z
  .record(
    z.string().min(1).max(64),
    z.unknown().refine((v) => v !== null && v !== undefined, 'may not be null')
  )
  .refine((o) => JSON.stringify(o).length <= MAX_INPUTS_JSON, {
    message: `must serialise to at most ${MAX_INPUTS_JSON} characters`,
  });

/**
 * Stored options, read defensively: anything that is not a plain object reads as none, and a
 * key the occurrence fills is dropped (the occurrence's value always wins anyway).
 */
export function storedInputs(
  raw: unknown,
  reserved: readonly string[] = []
): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const skip = new Set(reserved);
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !skip.has(k)));
}

/**
 * The options a template lets an automation of `source` set: its declared properties minus
 * the keys the occurrence fills.
 */
export function optionKeys(schema: InputSchema, source: Pick<EventSource, 'eventInputKeys'>) {
  const reserved = new Set<string>([...source.eventInputKeys, ...ALWAYS_FILLED]);
  return Object.keys(schema.properties).filter((k) => !reserved.has(k));
}

/** The template's declared options only — what a form renders for an automation. */
export function optionsSchema(
  schema: InputSchema,
  source: Pick<EventSource, 'eventInputKeys'>
): InputSchema {
  const keys = optionKeys(schema, source);
  return {
    properties: Object.fromEntries(
      keys.flatMap((k) => (schema.properties[k] ? [[k, schema.properties[k]]] : []))
    ),
    required: (schema.required ?? []).filter((k) => keys.includes(k)),
    type: 'object',
  };
}

export type AutomationPayloadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * The run payload an automation sends for one occurrence — the one place it is built, for the
 * save-time check and the fire alike:
 *
 *   1. every option the template declares, at its declared `default`;
 *   2. over that, the automation's own options — only keys the template declares;
 *   3. over that, the repository and what the occurrence fills, which always win.
 *
 * The result must pass the template's declared input schema and, where the source has one,
 * its payload contract (what the worker parses), so a payload the run would refuse is refused
 * here. An option the template does not declare is an error, so a typo is not a default.
 */
export function buildAutomationPayload<F, X>(
  source: EventSource<F, X>,
  inputSchema: unknown,
  inputs: unknown,
  connectionId: string,
  facts: X
): AutomationPayloadResult {
  if (!isInputSchema(inputSchema)) {
    return { errors: ['the template declares no input schema'], ok: false };
  }
  const options = new Set(optionKeys(inputSchema, source));
  const given = storedInputs(inputs, [...source.eventInputKeys, ...ALWAYS_FILLED]);
  const unknown = Object.keys(given).filter((k) => !options.has(k));
  if (unknown.length > 0) {
    return { errors: unknown.map((k) => `'${k}' is not an option of this template`), ok: false };
  }
  const defaults: Record<string, unknown> = {};
  for (const key of options) {
    const d = inputSchema.properties[key]?.default;
    if (d !== undefined) {
      defaults[key] = Array.isArray(d) ? [...d] : d;
    }
  }
  const run = source.run(facts);
  const payload: Record<string, unknown> = {
    ...defaults,
    ...given,
    connectionId,
    description: run.description,
    ticketId: run.ticketId,
    ...run.fields,
  };
  const declared = validateInputPayload(inputSchema, payload);
  if (!declared.ok) {
    return { errors: declared.errors, ok: false };
  }
  if (source.contract) {
    const contract = source.contract.safeParse(payload);
    if (!contract.success) {
      return {
        errors: contract.error.issues.map((i) => `'${i.path.join('.')}' ${i.message}`),
        ok: false,
      };
    }
  }
  return { ok: true, payload };
}

/**
 * Why an automation's options cannot be saved against a template, or null when they can:
 * checked against every shape of occurrence its filters can select.
 */
export function automationOptionsProblem<F, X>(
  source: EventSource<F, X>,
  filters: F,
  inputSchema: unknown,
  inputs: unknown
): string | null {
  // A key the occurrence fills is refused, not stored and silently overridden.
  const filled = new Set<string>([...source.eventInputKeys, ...ALWAYS_FILLED]);
  const named = Object.keys(storedInputs(inputs)).filter((k) => filled.has(k));
  if (named.length > 0) {
    return named.map((k) => `'${k}' is filled by each occurrence and cannot be set`).join('; ');
  }
  for (const facts of source.samples(filters)) {
    const built = buildAutomationPayload(
      source,
      inputSchema,
      inputs,
      '00000000-0000-4000-8000-000000000000',
      facts
    );
    if (!built.ok) {
      return built.errors.join('; ');
    }
  }
  return null;
}
