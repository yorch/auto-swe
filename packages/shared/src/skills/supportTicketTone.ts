import type { BuiltinSkillDef } from './index.js';

export const SUPPORT_TICKET_TONE_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'supportResponder', sortOrder: 10 }],
  description:
    'Guidelines for empathetic, professional, and brand-appropriate tone in customer-facing support replies.',
  name: 'support-ticket-tone',
  promptText: `## Support Ticket Tone

When drafting a customer-facing reply, use this tone and language guidance:

1. Lead with empathy. Acknowledge the customer's situation and, when appropriate, thank them for their patience or for reporting the issue.
2. Be direct and concise. Answer the question or explain the next step in the first one or two sentences.
3. Avoid jargon, internal acronyms, and overly technical detail unless the customer has already demonstrated familiarity with it.
4. Do not blame the customer. Use neutral language for causes: "this can happen when..." rather than "because you did...".
5. Do not over-promise. Use phrases like "I'll look into this" or "we're investigating" when a fix is not yet confirmed.
6. Keep a professional-but-friendly register. Avoid cold, robotic greetings and excessive formality.
7. Match the customer's energy. If they are frustrated, slow down and reassure. If they are casual, stay warm without being unprofessional.`,
};
