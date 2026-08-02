import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parses `schema.prisma` into model → column names.
 *
 * Several hand-maintained lists in this repo must cover every model or column
 * of some shape — `ENCRYPTED_FIELDS` (a missed column is skipped by key
 * rotation and dies with the old key) and `TENANT_SCOPED_MODELS` (a missed
 * model is unguarded). Each is checked against the schema by a drift test, and
 * each test used to carry its own copy of this parser, so a Prisma formatting
 * change had to be found and fixed twice.
 *
 * It throws rather than returning an empty map when it parses nothing: a
 * silently-empty result would make every caller's drift assertion pass
 * vacuously, which is the one failure these checks cannot afford.
 */

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.prisma');

/** Lower-camel Prisma client delegate name for a model. */
export function delegateName(model: string): string {
  return model[0].toLowerCase() + model.slice(1);
}

export function parseSchemaModels(schemaPath = SCHEMA_PATH): Record<string, string[]> {
  const schema = readFileSync(schemaPath, 'utf8');
  const models: Record<string, string[]> = {};
  let current: string | null = null;

  for (const line of schema.split('\n')) {
    const start = /^model (\w+) \{/.exec(line);
    if (start) {
      current = start[1];
      models[current] = [];
      continue;
    }
    if (line.trim() === '}') {
      current = null;
      continue;
    }
    if (!current) {
      continue;
    }
    // `  fieldName  Type  @attrs` — attribute lines (`@@map`, `@@index`) and
    // blanks do not match, which is what we want.
    const field = /^\s{2}(\w+)\s+\S/.exec(line);
    if (field) {
      models[current].push(field[1]);
    }
  }

  const total = Object.values(models).reduce((n, cols) => n + cols.length, 0);
  if (Object.keys(models).length < 10 || total < 50) {
    throw new Error(
      `parseSchemaModels matched only ${Object.keys(models).length} models / ${total} columns ` +
        `in ${schemaPath}. The schema format has probably changed — fix the parser rather than ` +
        'letting every drift check pass vacuously.'
    );
  }
  return models;
}

/** Models having every one of `columns`. */
export function modelsWithAnyColumn(columns: string[]): string[] {
  const wanted = new Set(columns);
  return Object.entries(parseSchemaModels())
    .filter(([, cols]) => cols.some((c) => wanted.has(c)))
    .map(([model]) => model)
    .sort();
}
