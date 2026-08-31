import crypto from 'node:crypto';

/**
 * Deterministic 0–99 bucket for an A/B key. Uses sha1 mod 100 so the same
 * `externalTicketId` always lands in the same bucket — re-runs of the same
 * ticket cannot accidentally cross the experiment boundary.
 *
 * Salting by `templateId` keeps two templates' experiments statistically
 * independent: a ticket bucketed into the experiment arm on template A is
 * uncorrelated with its bucket on template B.
 */
export function experimentBucket(externalTicketId: string, templateId: string): number {
  const hash = crypto.createHash('sha1').update(`${templateId}:${externalTicketId}`).digest();
  // First 4 bytes is plenty of entropy for a mod-100 bucket.
  return hash.readUInt32BE(0) % 100;
}
