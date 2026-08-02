import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENCRYPTED_FIELDS } from './keyRotation.js';

/**
 * Rotation is only as complete as its field map. A new encrypted column that
 * nobody adds to `ENCRYPTED_FIELDS` is silently skipped by
 * `rotateEncryptionKey`, and becomes permanently unreadable the moment the
 * previous key is dropped — the exact failure that is impossible to recover
 * from. So derive the truth from `schema.prisma` and fail when the two drift.
 */

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../prisma/schema.prisma'),
  'utf8'
);

/** `model X { … fooKeyVersion Int … }` → `{ x: ['fooKeyVersion'] }` */
function keyVersionColumnsFromSchema(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let model: string | null = null;
  for (const line of SCHEMA.split('\n')) {
    const start = /^model (\w+) \{/.exec(line);
    if (start) {
      model = start[1];
      continue;
    }
    if (line.trim() === '}') {
      model = null;
      continue;
    }
    const field = /^\s*(\w*[kK]eyVersion)\s+Int/.exec(line);
    if (field && model) {
      // Prisma client delegates are the model name, lower-camel.
      const delegate = model[0].toLowerCase() + model.slice(1);
      (out[delegate] ??= []).push(field[1]);
    }
  }
  return out;
}

describe('ENCRYPTED_FIELDS covers the schema', () => {
  const fromSchema = keyVersionColumnsFromSchema();

  it('finds key-version columns to check (the parser itself works)', () => {
    // Guards against the regex silently matching nothing, which would make
    // every assertion below vacuously pass.
    expect(Object.keys(fromSchema).length).toBeGreaterThan(5);
  });

  it('names every model that has an encrypted field', () => {
    expect(Object.keys(ENCRYPTED_FIELDS).sort()).toEqual(Object.keys(fromSchema).sort());
  });

  it('names every key-version column on those models', () => {
    for (const [model, columns] of Object.entries(fromSchema)) {
      const mapped = (ENCRYPTED_FIELDS[model] ?? []).map((f) => f.keyVersion).sort();
      expect(mapped, `model ${model}`).toEqual([...columns].sort());
    }
  });

  it('points every field at columns that exist in the schema', () => {
    for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
      for (const field of fields) {
        for (const column of [field.ciphertext, field.nonce, field.authTag, field.lastFour]) {
          if (!column) {
            continue;
          }
          expect(SCHEMA, `${model}.${column}`).toContain(column);
        }
      }
    }
  });
});
