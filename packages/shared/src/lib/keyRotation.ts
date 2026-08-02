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
  const report: RotationReport = { failed: [], rotated: {}, skipped: 0, toVersion };

  // The one cast that lets a typo'd model name compile, named and hoisted so it
  // is not buried in the loop body.
  type Delegate = {
    findMany: (a: unknown) => Promise<Row[]>;
    update: (a: unknown) => Promise<unknown>;
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
      report.rotated[model] = (report.rotated[model] ?? 0) + 1;
      if (!opts?.dryRun) {
        await delegate.update({ data, where: { id: row.id } });
      }
    }
  }

  return report;
}
