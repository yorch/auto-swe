/**
 * P3 — declarative run-input contracts.
 *
 * A `WorkflowTemplate.inputSchema` is a small JSON-Schema subset describing the
 * shape of the payload a run is submitted with. The gateway validates the
 * incoming run-input payload against it at submit time, so a template (SWE or
 * otherwise) declares its own inputs rather than the engine hard-coding the SWE
 * `{ ticketId, repoIds, … }` shape.
 *
 * Deliberately a tiny subset (object + scalar/array properties + `required` +
 * `enum` + `format:'uuid'` + string `maxLength`/`pattern`) so it needs no JSON-Schema dependency and stays
 * trivially serializable into the `Json` column. Unknown payload keys are
 * allowed (additive — like JSON Schema's default `additionalProperties: true`).
 */

import { UNIMPLEMENTED_CONNECTION_TYPES } from './connectionTypes.js';
import { checkRegexSafety } from './regexSafety.js';

export type InputFieldType = 'string' | 'number' | 'boolean' | 'array' | 'connection';

export interface InputSchemaProperty {
  type: InputFieldType;
  /** A human label for forms; the property name is shown when absent. */
  title?: string;
  description?: string;
  /**
   * The value a form starts from, and the one an automatic launcher (a trigger) fills in for
   * an option it was not given. Validation never fills it: a payload that omits the key is
   * checked as it is.
   */
  default?: string | number | boolean | (string | number)[];
  /** Allowed values (scalars only). */
  enum?: (string | number)[];
  /** Extra string constraint. */
  format?: 'uuid';
  /** Longest a `string` may be, in UTF-16 code units. Checked before `pattern`. */
  maxLength?: number;
  /** A `string` must match this expression in full (see {@link INPUT_PATTERN_MAX_VALUE_LENGTH}). */
  pattern?: string;
  /** Inclusive bounds for a `number`. */
  minimum?: number;
  maximum?: number;
  /** A `number` that must be a whole number. */
  integer?: boolean;
  /** Fewest and most elements an `array` may have when present. */
  minItems?: number;
  maxItems?: number;
  /**
   * Element type when `type === 'array'`, and optionally the values each element may take. No
   * `pattern`: an array's length has no bound of its own, so a per-item pattern is refused.
   */
  items?: {
    type: Exclude<InputFieldType, 'array' | 'connection'>;
    format?: 'uuid';
    enum?: (string | number)[];
    maxLength?: number;
  };
  /** When `type === 'connection'`, restricts the picker to connections of this type. */
  connectionType?: string;
}

export interface InputSchema {
  type: 'object';
  properties: Record<string, InputSchemaProperty>;
  required?: string[];
}

export type InputValidationResult = { ok: true } | { ok: false; errors: string[] };

/** Hard ceiling for `maxLength`. */
export const INPUT_MAX_LENGTH_LIMIT = 1000;
/** Longest `pattern` source accepted. */
export const INPUT_PATTERN_MAX_SOURCE_LENGTH = 200;
/**
 * Longest value a `pattern` is ever run against; a longer one fails without being tested, and a
 * schema that declares a larger `maxLength` beside a `pattern` is refused at save.
 */
export const INPUT_PATTERN_MAX_VALUE_LENGTH = 256;
/**
 * Most variable-count quantifiers (`?`, `*`, `+`, `{n,}`, `{n,m}` with `m > n`) one `pattern`
 * may contain; an exact `{n}` is not counted. Two are enough to make a run of exact blocks after
 * them cubic in the value's length, so only one is allowed.
 */
export const INPUT_PATTERN_MAX_REPETITIONS = 1;
/**
 * Most properties of one schema that may declare a `pattern`. Each is checked synchronously on
 * every launch, so the count bounds the total work a single payload can ask for.
 */
export const INPUT_PATTERN_MAX_FIELDS = 8;

// Permissive UUID matcher (any RFC-4122 variant/version).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Why a `pattern` is not acceptable, or null.
 *
 * A pattern is author-supplied data run in-process, on the request path, against text an
 * external event supplied, and a backtracking engine cannot be interrupted. `validateInputPayload`
 * is synchronous and so cannot use the pooled executor in `regexExec.ts`; the pattern is
 * confined to a subset whose work is bounded instead: literals, escapes, character classes,
 * anchors and quantifiers on a single atom. No groups, alternation, backreferences or lookaround,
 * and at most {@link INPUT_PATTERN_MAX_REPETITIONS} quantifier whose count varies. Every such
 * quantifier counts whatever its bound — `\w{0,5}` chained fourteen times backtracks as badly as
 * fourteen stars. With one, the only choice a backtracking engine has is how much that quantifier
 * takes: at most one attempt per length of the value plus one, and everything else in the
 * pattern (literals, classes, anchors, exact `{n}` blocks) matches each attempt without a choice,
 * reading at most the rest of the value and the pattern once. Values are capped at
 * {@link INPUT_PATTERN_MAX_VALUE_LENGTH} characters and sources at
 * {@link INPUT_PATTERN_MAX_SOURCE_LENGTH}, so one check is at most (256 + 1) × (256 + 200) steps,
 * which measured at about a millisecond on a first call and well under one after. That is a bound
 * on the search, not a proof about any particular engine's speed.
 */
export function inputPatternProblem(source: string): string | null {
  if (source.length === 0) {
    return 'must not be empty';
  }
  const safety = checkRegexSafety(source);
  if (safety) {
    return safety.message;
  }
  if (source.length > INPUT_PATTERN_MAX_SOURCE_LENGTH) {
    return `is ${source.length} characters; the maximum is ${INPUT_PATTERN_MAX_SOURCE_LENGTH}`;
  }
  let repetitions = 0;
  // A `?` straight after a quantifier makes it lazy; it is not a second quantifier.
  let afterQuantifier = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    const wasAfterQuantifier = afterQuantifier;
    afterQuantifier = false;
    if (c === '\\') {
      const n = source[i + 1] ?? '';
      if (/[1-9kpPcxu]/.test(n)) {
        return `may not use the escape \\${n} (backreferences and code-point escapes are not allowed)`;
      }
      i++;
    } else if (c === '[') {
      i++;
      if (source[i] === '^') {
        i++;
      }
      for (; i < source.length && source[i] !== ']'; i++) {
        if (source[i] === '\\') {
          i++;
        }
      }
    } else if (c === '(' || c === ')' || c === '|') {
      return 'may not use groups or alternation; use character classes and quantifiers';
    } else if (c === '*' || c === '+' || (c === '?' && !wasAfterQuantifier)) {
      repetitions++;
      afterQuantifier = true;
    } else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
      if (!m) {
        return "may not use a bare '{'; escape it as \\{";
      }
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Number.POSITIVE_INFINITY : Number(m[3]);
      if (Math.max(min, Number.isFinite(max) ? max : 0) > INPUT_MAX_LENGTH_LIMIT) {
        return `repetition bound exceeds ${INPUT_MAX_LENGTH_LIMIT}`;
      }
      if (max !== min) {
        repetitions++;
      }
      afterQuantifier = true;
      i += m[0].length - 1;
    }
  }
  if (repetitions > INPUT_PATTERN_MAX_REPETITIONS) {
    return `has ${repetitions} quantifiers whose count varies (?, *, +, {n,} or {n,m}); the maximum is ${INPUT_PATTERN_MAX_REPETITIONS}`;
  }
  try {
    new RegExp(`^(?:${source})$`);
  } catch {
    return 'is not a valid regular expression';
  }
  return null;
}

const UNUSABLE_PATTERN =
  "the template's input schema declares a pattern this platform does not run; fix the schema";
const UNUSABLE_ITEMS_PATTERN =
  "the template's input schema declares a pattern on array items, which is not supported; fix the schema";

const TOO_MANY_PATTERNS = `the template's input schema declares a pattern on more than ${INPUT_PATTERN_MAX_FIELDS} properties; fix the schema`;

const patternCache = new Map<string, RegExp | null>();

function compileInputPattern(source: string): RegExp | null {
  const hit = patternCache.get(source);
  if (hit !== undefined) {
    return hit;
  }
  let re: RegExp | null = null;
  if (inputPatternProblem(source) === null) {
    try {
      re = new RegExp(`^(?:${source})$`);
    } catch {
      re = null;
    }
  }
  if (patternCache.size > 500) {
    patternCache.clear();
  }
  patternCache.set(source, re);
  return re;
}

/** Narrow an unknown `Json` value to an `InputSchema`. */
export function isInputSchema(value: unknown): value is InputSchema {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.type === 'object' && typeof v.properties === 'object' && v.properties !== null;
}

/**
 * The connection IDs a payload supplies for the schema's `connection`-typed
 * fields, keyed by field name.
 *
 * A template may declare more than one connection — an issue tracker to read
 * from and a document store to write to — and each of them is a credential the
 * run will be handed. Every declared one therefore has to be authorized at
 * launch, exactly like the run's own `connectionId`; a field this function does
 * not report is a field nothing checks.
 *
 * Only non-empty strings are reported: validation has already rejected a
 * malformed value by the time this is consulted, and an absent optional field
 * simply names no connection.
 */
export function declaredConnectionInputs(
  schema: InputSchema | null | undefined,
  payload: unknown
): Array<{ field: string; connectionId: string; expectedType?: string }> {
  if (!schema || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return [];
  }
  const values = payload as Record<string, unknown>;
  const found: Array<{ field: string; connectionId: string; expectedType?: string }> = [];
  for (const [field, prop] of Object.entries(schema.properties)) {
    if (prop.type !== 'connection') {
      continue;
    }
    const value = values[field];
    if (typeof value !== 'string' || value.length === 0) {
      continue;
    }
    found.push({
      connectionId: value,
      ...(prop.connectionType ? { expectedType: prop.connectionType } : {}),
      field,
    });
  }
  return found;
}

/**
 * The connections a run is authorized for, as ids: its own workspace connection plus
 * every `connection`-typed field the template declares that the payload fills.
 *
 * Computed once at run creation and pinned on the run
 * (`WorkflowRun.authorizedConnectionIds`), because a template's `inputSchema` is mutable
 * while its spec is snapshotted — deriving the set at check time would let one schema
 * edit widen a run already in flight. A node that resolves a connection outside the
 * pinned set is refused where it is used, which is what makes the declared schema a
 * boundary rather than a hint: a connection named through a field the schema does not
 * describe is never in the set.
 */
export function runAuthorizedConnectionIds(args: {
  inputSchema: InputSchema | null | undefined;
  payload: unknown;
  workspaceConnectionId?: string | null;
}): string[] {
  const ids = new Set<string>(
    declaredConnectionInputs(args.inputSchema, args.payload).map((c) => c.connectionId)
  );
  if (args.workspaceConnectionId) {
    ids.add(args.workspaceConnectionId);
  }
  return [...ids];
}

function typeOf(value: unknown): InputFieldType | 'null' | 'object' {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    return t;
  }
  return 'object';
}

function checkScalar(
  key: string,
  value: unknown,
  prop: Pick<
    InputSchemaProperty,
    'type' | 'format' | 'enum' | 'minimum' | 'maximum' | 'integer' | 'maxLength' | 'pattern'
  >,
  errors: string[]
): void {
  const actual = typeOf(value);
  // `connection` is a UUID under the hood — treat it as a string for the type check.
  const expectedType = prop.type === 'connection' ? 'string' : prop.type;
  if (actual !== expectedType) {
    errors.push(`'${key}' must be a ${prop.type} (got ${actual})`);
    return;
  }
  const expectsUuid =
    (prop.type === 'string' && prop.format === 'uuid') || prop.type === 'connection';
  if (expectsUuid && typeof value === 'string' && !UUID_RE.test(value)) {
    // A `connection` field is a connection ID; a plain uuid-format string is just a UUID.
    errors.push(
      prop.type === 'connection'
        ? `'${key}' must be a valid connection ID (UUID)`
        : `'${key}' must be a UUID`
    );
  }
  if (prop.type === 'string' && typeof value === 'string') {
    // Length first, so a pattern never runs over more than it is willing to read. The value
    // is never echoed: it came from outside.
    const tooLong = typeof prop.maxLength === 'number' && value.length > prop.maxLength;
    if (tooLong) {
      errors.push(`'${key}' must be at most ${prop.maxLength} characters`);
    }
    if (prop.pattern !== undefined && !tooLong) {
      // A stored pattern outside the accepted subset (saved before the subset was enforced, or
      // written around the save check) is never run: every value is refused, and the error names
      // the schema, not the value, as the thing to fix.
      const re = typeof prop.pattern === 'string' ? compileInputPattern(prop.pattern) : null;
      if (re === null) {
        errors.push(`'${key}' cannot be checked: ${UNUSABLE_PATTERN}`);
      } else if (value.length > INPUT_PATTERN_MAX_VALUE_LENGTH || !re.test(value)) {
        errors.push(`'${key}' does not match the required pattern`);
      }
    }
  }
  if (Array.isArray(prop.enum) && !prop.enum.includes(value as string | number)) {
    errors.push(`'${key}' must be one of: ${prop.enum.join(', ')}`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      errors.push(`'${key}' must be a finite number`);
    } else if (prop.integer === true && !Number.isInteger(value)) {
      errors.push(`'${key}' must be a whole number`);
    } else if (prop.minimum !== undefined && value < prop.minimum) {
      errors.push(`'${key}' must be at least ${prop.minimum}`);
    } else if (prop.maximum !== undefined && value > prop.maximum) {
      errors.push(`'${key}' must be at most ${prop.maximum}`);
    }
  }
}

/**
 * Validate a payload against an `InputSchema`. Returns all violations at once so
 * the caller can surface a complete error to the submitter.
 */
export function validateInputPayload(schema: InputSchema, payload: unknown): InputValidationResult {
  const errors: string[] = [];
  if (typeOf(payload) !== 'object') {
    return { errors: ['payload must be an object'], ok: false };
  }
  const obj = payload as Record<string, unknown>;

  for (const key of schema.required ?? []) {
    if (obj[key] === undefined || obj[key] === null) {
      errors.push(`'${key}' is required`);
    }
  }

  // The patterned properties a schema may run, in declaration order: past the cap (refused at
  // save; a stored schema can still carry more) a pattern fails closed instead of adding work.
  const runnable = new Set(
    Object.entries(schema.properties)
      .filter(([, p]) => typeof p === 'object' && p !== null && p.pattern !== undefined)
      .slice(0, INPUT_PATTERN_MAX_FIELDS)
      .map(([k]) => k)
  );
  for (const [key, prop] of Object.entries(schema.properties)) {
    const value = obj[key];
    if (value === undefined || value === null) {
      continue; // presence handled by `required`
    }
    if (
      typeof prop === 'object' &&
      prop !== null &&
      prop.pattern !== undefined &&
      !runnable.has(key)
    ) {
      errors.push(`'${key}' cannot be checked: ${TOO_MANY_PATTERNS}`);
      continue;
    }
    if (typeof prop !== 'object' || prop === null) {
      // Refused at save; a stored one fails closed instead of throwing.
      errors.push(`'${key}' cannot be checked: the template's input schema does not describe it`);
      continue;
    }
    if (prop.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`'${key}' must be an array (got ${typeOf(value)})`);
        continue;
      }
      if (prop.minItems !== undefined && value.length < prop.minItems) {
        errors.push(`'${key}' must have at least ${prop.minItems} item(s)`);
      }
      if (prop.maxItems !== undefined && value.length > prop.maxItems) {
        errors.push(`'${key}' must have at most ${prop.maxItems} item(s)`);
      }
      const items = prop.items;
      if (items && (items as Record<string, unknown>).pattern !== undefined) {
        // Not supported on items: an item count has no bound of its own, so a pattern per item is
        // work proportional to the body. Refused at save; a stored one fails closed, once.
        errors.push(`'${key}' cannot be checked: ${UNUSABLE_ITEMS_PATTERN}`);
      } else if (items) {
        value.forEach((el, i) => {
          checkScalar(
            `${key}[${i}]`,
            el,
            {
              enum: items.enum,
              format: items.format,
              maxLength: items.maxLength,
              type: items.type,
            },
            errors
          );
        });
      }
      continue;
    }
    checkScalar(key, value, prop, errors);
  }

  return errors.length === 0 ? { ok: true } : { errors, ok: false };
}

const FIELD_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
  'array',
  'connection',
]);
const SCALAR_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'boolean']);

function isScalarList(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number');
}

function isCount(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function stringConstraintProblems(
  p: Record<string, unknown>,
  isString: boolean,
  at: (m: string) => void
): void {
  for (const k of ['maxLength', 'pattern'] as const) {
    if (p[k] !== undefined && !isString) {
      at(`${k} applies only to a string`);
      return;
    }
  }
  const ml = p.maxLength;
  if (
    ml !== undefined &&
    !(typeof ml === 'number' && Number.isInteger(ml) && ml >= 1 && ml <= INPUT_MAX_LENGTH_LIMIT)
  ) {
    at(`maxLength must be a whole number from 1 to ${INPUT_MAX_LENGTH_LIMIT}`);
  }
  if (p.pattern !== undefined) {
    if (typeof p.pattern !== 'string') {
      at('pattern must be a string');
    } else {
      const problem = inputPatternProblem(p.pattern);
      if (problem) {
        at(`pattern ${problem}`);
      }
      if (typeof ml === 'number' && ml > INPUT_PATTERN_MAX_VALUE_LENGTH) {
        at(`maxLength may not exceed ${INPUT_PATTERN_MAX_VALUE_LENGTH} when a pattern is set`);
      }
    }
  }
}

/**
 * What is wrong with a declared input schema's shape, beyond `isInputSchema`'s outline: each
 * property's keyword has the type this module and the forms read it as. Empty when it is
 * sound. Checked where a schema is saved; `isInputSchema` stays lenient, since a caller that
 * finds no schema validates nothing.
 */
export function inputSchemaProblems(value: unknown): string[] {
  if (!isInputSchema(value)) {
    return ["inputSchema must be `{ type: 'object', properties: { … } }`"];
  }
  const problems: string[] = [];
  const req = (value as { required?: unknown }).required;
  if (req !== undefined && !(Array.isArray(req) && req.every((k) => typeof k === 'string'))) {
    problems.push('required must be a list of property names');
  }
  const patterned = Object.entries(value.properties as Record<string, unknown>).filter(
    ([, raw]) =>
      typeof raw === 'object' &&
      raw !== null &&
      (raw as { pattern?: unknown }).pattern !== undefined
  );
  if (patterned.length > INPUT_PATTERN_MAX_FIELDS) {
    problems.push(
      `${patterned.length} properties declare a pattern; the maximum is ${INPUT_PATTERN_MAX_FIELDS} (${patterned
        .slice(INPUT_PATTERN_MAX_FIELDS)
        .map(([k]) => `'${k}'`)
        .join(', ')} over the limit)`
    );
  }
  for (const [key, raw] of Object.entries(value.properties as Record<string, unknown>)) {
    const at = (m: string) => problems.push(`'${key}': ${m}`);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      at('must be an object');
      continue;
    }
    const p = raw as Record<string, unknown>;
    if (typeof p.type !== 'string' || !FIELD_TYPES.has(p.type)) {
      at(`type must be one of ${[...FIELD_TYPES].join(', ')}`);
      continue;
    }
    for (const k of ['title', 'description', 'connectionType'] as const) {
      if (p[k] !== undefined && typeof p[k] !== 'string') {
        at(`${k} must be a string`);
      }
    }
    if (p.format !== undefined && p.format !== 'uuid') {
      at("format may only be 'uuid'");
    }
    // The platform fills these two from text it either receives or is given: an external ticket
    // id, and a description. Typing one as a `connection` would make that text the connection a
    // run uses — chosen by whoever supplies the ticket — and the run's authorized set is derived
    // from the payload, so no launch path would notice. `connectionId` is deliberately not here:
    // it *is* a connection, the run's own, which every launch authorizes.
    if (
      p.type === 'connection' &&
      typeof p.connectionType === 'string' &&
      (UNIMPLEMENTED_CONNECTION_TYPES as readonly string[]).includes(p.connectionType)
    ) {
      at(
        `connectionType '${p.connectionType}' has no connector yet: no step can act on it, so a template cannot declare it`
      );
    }
    if (p.type === 'connection' && (key === 'ticketId' || key === 'description')) {
      at('may not be a connection: the platform fills this key from text, not from a picker');
    }
    stringConstraintProblems(p, p.type === 'string', at);
    if (p.enum !== undefined && !isScalarList(p.enum)) {
      at('enum must be a list of strings or numbers');
    }
    for (const k of ['minimum', 'maximum'] as const) {
      if (p[k] !== undefined && !(typeof p[k] === 'number' && Number.isFinite(p[k]))) {
        at(`${k} must be a number`);
      }
    }
    if (p.integer !== undefined && typeof p.integer !== 'boolean') {
      at('integer must be true or false');
    }
    for (const k of ['minItems', 'maxItems'] as const) {
      if (p[k] !== undefined && !isCount(p[k])) {
        at(`${k} must be a whole number of at least 0`);
      }
    }
    if (p.items !== undefined) {
      const items = p.items as Record<string, unknown> | null;
      if (
        typeof items !== 'object' ||
        items === null ||
        typeof items.type !== 'string' ||
        !SCALAR_TYPES.has(items.type)
      ) {
        at('items must be { type: string | number | boolean }');
      } else {
        if (items.enum !== undefined && !isScalarList(items.enum)) {
          at('items.enum must be a list of strings or numbers');
        }
        if (items.pattern !== undefined) {
          at(
            'items.pattern is not supported (an array has no bound on its item count); constrain items with enum or maxLength'
          );
        }
        stringConstraintProblems({ ...items, pattern: undefined }, items.type === 'string', (m) =>
          at(`items.${m}`)
        );
      }
    }
    if (p.default !== undefined) {
      const fits =
        p.type === 'array'
          ? isScalarList(p.default)
          : p.type === 'connection'
            ? typeof p.default === 'string'
            : typeof p.default === p.type;
      if (!fits) {
        at(`default must be a ${p.type}`);
      }
    }
  }
  return problems;
}
