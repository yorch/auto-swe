/**
 * Shared constants for the channel-assistant activities (`channelAmbient.ts`,
 * `channelReactive.ts`, `flagOrgSignals.ts`, `channelAssistant.ts`,
 * `passiveIngestChannelMemory.ts`, `consolidateChannelMemory.ts`,
 * `consolidateLessons.ts`). Centralizes values that were previously
 * copy-pasted identically across those files — see each constant's doc
 * comment for the behavioral contract it encodes.
 */

/**
 * Matches a reply that begins with the word `skip` (case-insensitive, after
 * trimming) — e.g. `SKIP`, `skip`, or a decorated `SKIP - nothing actionable`.
 * Any such reply is treated as the skip sentinel and is NOT posted.
 */
export const SKIP_SENTINEL = /^skip\b/i;

/** Default cosine-similarity threshold for memory de-duplication / clustering. */
export const DEFAULT_MEMORY_DEDUP_THRESHOLD = 0.85;
