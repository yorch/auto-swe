import { prisma } from '@auto-swe/shared/db';

/**
 * Resolve the effective persona prompt for a channel turn.
 *
 * Resolution cascade (most-specific wins):
 *   1. `channelPersonaPrompt` — set directly on the SlackChannel row
 *   2. `Organization.defaultPersonaPrompt` — org-wide default
 *   3. `null` — no persona; system prompt is unchanged
 *
 * The returned string is ready to prepend to any system prompt.
 */
export async function resolvePersonaPrompt(
  channelPersonaPrompt: string | null | undefined,
  orgId: string
): Promise<string | null> {
  const channelLevel = channelPersonaPrompt?.trim() || null;
  if (channelLevel) {
    return channelLevel;
  }
  const org = await prisma.organization.findUnique({
    select: { defaultPersonaPrompt: true },
    where: { id: orgId },
  });
  return org?.defaultPersonaPrompt?.trim() || null;
}

/**
 * Prepend a persona prompt to a system prompt string.
 * Returns the original when persona is null.
 */
export function applyPersona(systemPrompt: string, persona: string | null): string {
  if (!persona) {
    return systemPrompt;
  }
  return `${persona}\n\n${systemPrompt}`;
}
