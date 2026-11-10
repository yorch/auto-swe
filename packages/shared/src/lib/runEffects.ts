import { z } from 'zod';

/** What kind of outside change a `RunEffect` row records. */
export const RUN_EFFECT_KINDS = [
  'MCP_TOOL',
  'PULL_REQUEST',
  'GIT_PUSH',
  'TRACKER',
  'KNOWLEDGE_BASE',
] as const;
export const runEffectKindSchema = z.enum(RUN_EFFECT_KINDS);
export type RunEffectKind = z.infer<typeof runEffectKindSchema>;

export const RUN_EFFECT_STATUSES = ['DONE', 'FAILED'] as const;
export const runEffectStatusSchema = z.enum(RUN_EFFECT_STATUSES);
export type RunEffectStatus = z.infer<typeof runEffectStatusSchema>;

/** The path an effect took to the outside: the harness relay, the Mastra MCP binding, or an activity. */
export const RUN_EFFECT_VIAS = ['harness_relay', 'mastra_mcp', 'activity'] as const;
export const runEffectViaSchema = z.enum(RUN_EFFECT_VIAS);
export type RunEffectVia = z.infer<typeof runEffectViaSchema>;

/** Caps on what one row stores: the ledger is a summary, not a transcript. */
export const RUN_EFFECT_DETAIL_MAX_CHARS = 4_000;
export const RUN_EFFECT_ERROR_MAX_CHARS = 1_000;
