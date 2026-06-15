/**
 * P3 slice 4 — generic triggers.
 *
 * A `TriggerMapping` is declarative config that turns an inbound event (a GitHub
 * webhook body, a Jira webhook body, a schedule fire, …) into a run-input
 * payload — the same payload shape a template's `inputSchema` validates. This is
 * what decouples *what fires a run* from the SWE specifics: the engine has no
 * hard-coded "issue.labeled → ticket" path; instead a mapping (seed/config)
 * declares which event fields populate which payload keys, and the produced
 * payload is then validated against the target template's `inputSchema`
 * (`validateInputPayload`) exactly like a manual submission.
 *
 * Deliberately tiny + dependency-free (dot-path extraction + a couple of string
 * transforms + constants) so mappings serialize trivially and a non-SWE source
 * can declare its own without engine changes.
 */

export type TriggerTransform = 'toString' | 'beforeSlash' | 'afterSlash' | 'lower';

export interface TriggerFieldMapping {
  /** Target run-input payload key, e.g. `'ticketId'`. */
  to: string;
  /** Dot-path into the event object, e.g. `'issue.number'`. */
  from?: string;
  /** Constant value when there is no `from` (e.g. a fixed budget tier). */
  const?: string | number | boolean;
  /** Optional value transform applied after extraction. */
  transform?: TriggerTransform;
}

export interface TriggerMapping {
  /** Event source: `'github'`, `'jira'`, `'schedule'`, `'manual'`, … */
  source: string;
  /** Optional event discriminator, e.g. `'issues.labeled'` (informational). */
  event?: string;
  /** Template this trigger fires, resolved to id/version at fire time. */
  templateName: string;
  /** Declarative field extraction. */
  fields: TriggerFieldMapping[];
}

/** Read a dot-path (`'a.b.c'`) out of a nested object; undefined if any hop misses. */
export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function applyTransform(value: unknown, transform: TriggerTransform | undefined): unknown {
  if (value === undefined || value === null || transform === undefined) {
    return value;
  }
  const str = String(value);
  switch (transform) {
    case 'toString':
      return str;
    case 'lower':
      return str.toLowerCase();
    case 'beforeSlash':
      return str.split('/')[0];
    case 'afterSlash':
      return str.split('/').slice(1).join('/');
  }
}

/**
 * Apply a `TriggerMapping` to an event, producing a run-input payload. Missing
 * `from` paths are simply omitted (so `required`/`inputSchema` validation
 * downstream reports them) — mapping never throws on a shape it doesn't expect.
 */
export function mapEventToRunInput(
  mapping: TriggerMapping,
  event: unknown
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of mapping.fields) {
    let value: unknown;
    if (field.from !== undefined) {
      value = applyTransform(getByPath(event, field.from), field.transform);
    } else if (field.const !== undefined) {
      value = field.const;
    }
    if (value !== undefined) {
      payload[field.to] = value;
    }
  }
  return payload;
}

/**
 * SWE seed trigger mappings (removable SWE content, like the built-in
 * templates). Each maps a source event onto the SWE input contract
 * `{ ticketId, connectionId, description, budget }`. `repoFullName` is produced
 * for the receiver to resolve to a `connectionId` (a `git_repo` Connection
 * lookup by org/repo) — the pure mapping stays free of DB access.
 */
export const SWE_TRIGGER_MAPPINGS: TriggerMapping[] = [
  {
    event: 'issues.labeled',
    fields: [
      { from: 'issue.number', to: 'ticketId', transform: 'toString' },
      { from: 'issue.title', to: 'description' },
      { from: 'repository.full_name', to: 'repoFullName' },
      { const: 'STANDARD', to: 'budget' },
    ],
    source: 'github',
    templateName: 'default-engineering',
  },
  {
    event: 'jira:issue_updated',
    fields: [
      { from: 'issue.key', to: 'ticketId' },
      { from: 'issue.fields.summary', to: 'description' },
      { const: 'STANDARD', to: 'budget' },
    ],
    source: 'jira',
    templateName: 'default-engineering',
  },
];
