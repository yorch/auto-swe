import { describe, expect, it } from 'vitest';
import { delegateName, parseSchemaModels } from '../prisma/schemaModels.js';
import { ENCRYPTED_FIELDS } from './keyRotation.js';

/**
 * Rotation is only as complete as its field map. A new encrypted column that
 * nobody adds to `ENCRYPTED_FIELDS` is silently skipped by
 * `rotateEncryptionKey`, and becomes permanently unreadable the moment the
 * previous key is dropped — the one failure here that cannot be recovered from.
 * So derive the truth from `schema.prisma` and fail when the two drift.
 *
 * `parseSchemaModels` throws rather than returning nothing if the schema format
 * changes, so these assertions cannot pass vacuously.
 */

const MODELS = parseSchemaModels();

/** model → its `*KeyVersion` columns, keyed by client delegate name. */
const keyVersionColumns: Record<string, string[]> = {};
for (const [model, columns] of Object.entries(MODELS)) {
  const versions = columns.filter((c) => /[kK]eyVersion$/.test(c));
  if (versions.length > 0) {
    keyVersionColumns[delegateName(model)] = versions;
  }
}

describe('ENCRYPTED_FIELDS covers the schema', () => {
  it('names every model that has an encrypted field', () => {
    expect(Object.keys(ENCRYPTED_FIELDS).sort()).toEqual(Object.keys(keyVersionColumns).sort());
  });

  it('names every key-version column on those models', () => {
    for (const [model, columns] of Object.entries(keyVersionColumns)) {
      const mapped = (ENCRYPTED_FIELDS[model] ?? []).map((f) => f.keyVersion).sort();
      expect(mapped, `model ${model}`).toEqual([...columns].sort());
    }
  });

  it('points every field at columns that exist on that model', () => {
    // Checked per model, not against the whole file: a column name that exists
    // on some *other* model would otherwise satisfy a substring search and let
    // a mis-assigned field through.
    for (const [delegate, fields] of Object.entries(ENCRYPTED_FIELDS)) {
      const model = Object.keys(MODELS).find((m) => delegateName(m) === delegate);
      expect(model, `no model for delegate ${delegate}`).toBeDefined();
      const columns = new Set(MODELS[model as string]);
      for (const field of fields) {
        for (const column of [field.ciphertext, field.nonce, field.authTag, field.lastFour]) {
          if (column) {
            expect(columns.has(column), `${delegate}.${column}`).toBe(true);
          }
        }
      }
    }
  });
});
