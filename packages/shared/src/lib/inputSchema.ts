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
 * `enum` + `format:'uuid'`) so it needs no JSON-Schema dependency and stays
 * trivially serializable into the `Json` column. Unknown payload keys are
 * allowed (additive — like JSON Schema's default `additionalProperties: true`).
 */

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
  /** Inclusive bounds for a `number`. */
  minimum?: number;
  maximum?: number;
  /** Fewest elements an `array` may have when present. */
  minItems?: number;
  /** Element type when `type === 'array'`, and optionally the values each element may take. */
  items?: {
    type: Exclude<InputFieldType, 'array' | 'connection'>;
    format?: 'uuid';
    enum?: (string | number)[];
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

// Permissive UUID matcher (any RFC-4122 variant/version).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Narrow an unknown `Json` value to an `InputSchema`. */
export function isInputSchema(value: unknown): value is InputSchema {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.type === 'object' && typeof v.properties === 'object' && v.properties !== null;
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
  prop: Pick<InputSchemaProperty, 'type' | 'format' | 'enum' | 'minimum' | 'maximum'>,
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
  if (prop.enum && !prop.enum.includes(value as string | number)) {
    errors.push(`'${key}' must be one of: ${prop.enum.join(', ')}`);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      errors.push(`'${key}' must be a finite number`);
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

  for (const [key, prop] of Object.entries(schema.properties)) {
    const value = obj[key];
    if (value === undefined || value === null) {
      continue; // presence handled by `required`
    }
    if (prop.type === 'array') {
      if (!Array.isArray(value)) {
        errors.push(`'${key}' must be an array (got ${typeOf(value)})`);
        continue;
      }
      if (prop.minItems !== undefined && value.length < prop.minItems) {
        errors.push(`'${key}' must have at least ${prop.minItems} item(s)`);
      }
      const items = prop.items;
      if (items) {
        value.forEach((el, i) => {
          checkScalar(
            `${key}[${i}]`,
            el,
            { enum: items.enum, format: items.format, type: items.type },
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
