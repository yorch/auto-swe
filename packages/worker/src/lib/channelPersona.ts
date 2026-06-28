/**
 * Resolve the effective persona prompt for a channel turn.
 *
 * Resolution cascade (most-specific wins):
 *   1. `channelPersonaPrompt` — set directly on the SlackChannel row
 *   2. `teamDefaultPersonaPrompt` — team-wide default (caller pre-fetches via relation)
 *   3. `null` — no persona; system prompt is unchanged
 *
 * The returned string is ready to prepend to any system prompt.
 * Callers must include `team: { select: { defaultPersonaPrompt: true } }` in
 * their channel query and pass `channel.team?.defaultPersonaPrompt` as the
 * second argument — this eliminates the extra DB round-trip.
 */
export function resolvePersonaPrompt(
  channelPersonaPrompt: string | null | undefined,
  teamDefaultPersonaPrompt: string | null | undefined
): string | null {
  return channelPersonaPrompt?.trim() || teamDefaultPersonaPrompt?.trim() || null;
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
