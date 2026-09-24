import { prisma } from '../db.js';
import { modelName } from '../prisma/schemaModels.js';
import { currentKeyVersion, decryptSecret, encryptSecret } from './crypto.js';
import { runUnscoped } from './tenantGuard.js';

/**
 * Re-encrypts every secret under the current `CONFIG_ENCRYPTION_KEY`.
 *
 * `keyVersion` columns existed from the start but nothing could change them:
 * `decryptSecret` rejected any version that was not the one this process held,
 * so introducing a new master key made every stored secret unreadable. Rotation
 * is now: set `CONFIG_ENCRYPTION_KEY` to the new key, bump
 * `CONFIG_ENCRYPTION_KEY_VERSION`, keep the old key in
 * `CONFIG_ENCRYPTION_KEY_PREVIOUS`, restart, run this, then drop the previous
 * key.
 *
 * Each row is read, decrypted with whichever version it carries, re-encrypted
 * with the current one, and written back in a single update. There is no global
 * transaction: a row already at the current version is skipped, so an
 * interrupted run is simply resumed by running it again.
 *
 * The write-back is conditional. Rotation runs against a live deployment, so an
 * admin can save a new secret between this read and its write; an update keyed
 * by `id` alone would then overwrite the fresh secret with the re-encrypted OLD
 * one. Every rotated field's nonce and key version as read are part of the
 * `where` (a nonce is random per encryption, so a re-save always changes it),
 * and a row whose update matches nothing is reported in `conflicted` and left
 * alone — the next run picks it up.
 */

/** One encrypted field: the three ciphertext columns plus its version column. */
export interface EncryptedField {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: string;
  /** Only for `lastFour`-carrying fields; re-encryption preserves it anyway. */
  lastFour?: string;
}

/**
 * Every encrypted field in the schema, by model.
 *
 * `keyRotation.coverage.test.ts` derives the same set from `schema.prisma` and
 * fails when the two disagree — a new encrypted column that nobody adds here
 * would otherwise be silently skipped by rotation and become unreadable the
 * moment the old key is dropped.
 */
/**
 * The four (or five) columns of one encrypted field, from its shared prefix.
 *
 * Every encrypted field in the schema follows `<prefix>Ciphertext` /`Nonce`
 * /`AuthTag` /`KeyVersion` /`LastFour`. Spelling those out per field made a
 * 130-line table in which a swapped `nonce`/`authTag` pair still satisfied the
 * coverage test — it compares column *sets*, not roles. Deriving them makes
 * that class of typo impossible for the regular case and leaves the one
 * irregular row visibly irregular.
 */
function fieldsFor(prefix: string): EncryptedField {
  return {
    authTag: `${prefix}AuthTag`,
    ciphertext: `${prefix}Ciphertext`,
    keyVersion: `${prefix}KeyVersion`,
    lastFour: `${prefix}LastFour`,
    nonce: `${prefix}Nonce`,
  };
}

/**
 * Every encrypted field in the schema, by Prisma delegate.
 *
 * `keyRotation.coverage.test.ts` derives the same set from `schema.prisma` and
 * fails when the two disagree — a new encrypted column that nobody adds here
 * would otherwise be silently skipped by rotation and become unreadable the
 * moment the old key is dropped.
 */
export const ENCRYPTED_FIELDS: Record<string, EncryptedField[]> = {
  // Connection stores an encrypted API token without a last-four column.
  connection: [
    {
      authTag: 'apiKeyAuthTag',
      ciphertext: 'apiKeyCiphertext',
      keyVersion: 'apiKeyVersion',
      nonce: 'apiKeyNonce',
    },
  ],
  figmaConfig: [fieldsFor('apiToken')],
  gitHubConfig: [
    fieldsFor('token'),
    fieldsFor('webhookSecret'),
    fieldsFor('oauthClientSecret'),
    fieldsFor('appClientSecret'),
    fieldsFor('appPrivateKey'),
  ],
  googleOAuthConfig: [fieldsFor('clientSecret')],
  issueTrackerConfig: [fieldsFor('apiToken'), fieldsFor('webhookSecret')],
  knowledgeBaseConfig: [fieldsFor('apiToken')],
  oktaOAuthConfig: [fieldsFor('clientSecret')],
  // The one irregular row: its version and last-four columns are unprefixed.
  providerCredential: [{ ...fieldsFor('apiKey'), keyVersion: 'keyVersion', lastFour: 'lastFour' }],
  slackConfig: [fieldsFor('clientSecret'), fieldsFor('signingSecret'), fieldsFor('botToken')],
  slackWorkspace: [fieldsFor('botToken')],
  storageConfig: [fieldsFor('awsSecretAccessKey')],
};

export interface RotationReport {
  /** Rows re-encrypted, by model. */
  rotated: Record<string, number>;
  /** Fields already at the current version. */
  skipped: number;
  /** Fields that failed to decrypt — reported, never swallowed. */
  failed: Array<{ model: string; id: string; field: string; reason: string }>;
  /**
   * Rows whose secret changed between the read and the write-back (or that
   * were deleted). Not written — run rotation again to move them.
   */
  conflicted: Array<{ model: string; id: string }>;
  toVersion: number;
}

type Row = Record<string, unknown> & { id: string };

/**
 * @param dryRun report what would change without writing. Use it first: a
 *   rotation that cannot decrypt some row should be discovered before half the
 *   table has moved to a key the rest cannot be read with.
 */
export async function rotateEncryptionKey(opts?: { dryRun?: boolean }): Promise<RotationReport> {
  const toVersion = currentKeyVersion();
  const report: RotationReport = {
    conflicted: [],
    failed: [],
    rotated: {},
    skipped: 0,
    toVersion,
  };

  // The one cast that lets a typo'd model name compile, named and hoisted so it
  // is not buried in the loop body.
  type Delegate = {
    findMany: (a: unknown) => Promise<Row[]>;
    updateMany: (a: unknown) => Promise<{ count: number }>;
  };
  const client = prisma as unknown as Record<string, Delegate | undefined>;

  for (const [model, fields] of Object.entries(ENCRYPTED_FIELDS)) {
    const delegate = client[model];
    if (!delegate) {
      throw new Error(`ENCRYPTED_FIELDS names model '${model}', which is not on the Prisma client`);
    }

    // Rotation is a deployment-wide operation on the ciphertext column itself —
    // it re-encrypts every row regardless of owner, and skipping a tenant's rows
    // would leave them unreadable once the old key is dropped. `ENCRYPTED_FIELDS`
    // is keyed by delegate name; the guard keys off the model name.
    const rows = await runUnscoped(
      'key rotation must re-encrypt every row; a skipped tenant loses its secrets',
      [modelName(model)],
      () => delegate.findMany({})
    );
    for (const row of rows) {
      const data: Record<string, unknown> = {};
      // What the row must still hold for the write-back to be safe.
      const expected: Record<string, unknown> = {};

      for (const field of fields) {
        const ciphertext = row[field.ciphertext];
        const version = row[field.keyVersion];
        // An unset optional secret has no ciphertext to move.
        if (!ciphertext || typeof version !== 'number') {
          continue;
        }
        if (version === toVersion) {
          report.skipped += 1;
          continue;
        }

        try {
          const plaintext = decryptSecret({
            authTag: row[field.authTag] as Uint8Array,
            ciphertext: ciphertext as Uint8Array,
            keyVersion: version,
            nonce: row[field.nonce] as Uint8Array,
          });
          const sealed = encryptSecret(plaintext);
          data[field.ciphertext] = sealed.ciphertext;
          data[field.nonce] = sealed.nonce;
          data[field.authTag] = sealed.authTag;
          data[field.keyVersion] = sealed.keyVersion;
          expected[field.nonce] = row[field.nonce];
          expected[field.keyVersion] = version;
          if (field.lastFour) {
            data[field.lastFour] = sealed.lastFour;
          }
        } catch (err) {
          report.failed.push({
            field: field.ciphertext,
            id: row.id,
            model,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (Object.keys(data).length === 0) {
        continue;
      }
      if (opts?.dryRun) {
        report.rotated[model] = (report.rotated[model] ?? 0) + 1;
        continue;
      }
      const { count } = await runUnscoped(
        'key rotation must re-encrypt every row; a skipped tenant loses its secrets',
        [modelName(model)],
        () => delegate.updateMany({ data, where: { ...expected, id: row.id } })
      );
      if (count === 0) {
        report.conflicted.push({ id: row.id, model });
        continue;
      }
      report.rotated[model] = (report.rotated[model] ?? 0) + 1;
    }
  }

  return report;
}
