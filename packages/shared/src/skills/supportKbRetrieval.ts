import type { BuiltinSkillDef } from './index.js';

export const SUPPORT_KB_RETRIEVAL_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'supportResponder', sortOrder: 20 }],
  description:
    'How to infer and cite relevant knowledge-base guidance from the ticket context when no live KB search is available.',
  name: 'support-kb-retrieval',
  promptText: `## Support Knowledge-Base Retrieval

You do not have a live knowledge-base search in this mode. Instead, use the ticket context to surface likely KB guidance:

1. Identify the product area, error message, feature name, or workflow the customer is asking about.
2. Reference any known standard steps, troubleshooting paths, or configuration notes that are generally true for that area.
3. If a previous public comment or the ticket description already quotes a known solution, prefer and consolidate that answer.
4. Cite the source of your guidance when it comes from the ticket itself: "Based on the previous update..." or "As noted in the earlier steps...".
5. When the KB answer is not present in the context, say so explicitly and ask the customer for the missing detail rather than fabricate a procedure.`,
};
