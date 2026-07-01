import type { BuiltinSkillDef } from './index.js';

export const DESIGN_FIDELITY_SKILL: BuiltinSkillDef = {
  assignments: [{ role: 'implementer', sortOrder: 17 }],
  description:
    'Guides faithful implementation of UI work against a referenced Figma design (frames, tokens, components).',
  name: 'design-fidelity',
  promptText: `## Design Fidelity

When a work request references a Figma design (a \`figma.com/file/...\` or \`figma.com/design/...\` link, or a \`design\` block in the task context), treat the design as the **specification for visual output** — do not invent values the design already defines.

- **Read the design first.** If Figma tools are available (an \`mcp:*\` tool that fetches Figma nodes), fetch the specific referenced frame/node *before* writing UI code. If a compact \`design\` summary is already in the task context, use it. Never guess layout, spacing, color, or typography that the design pins down.
- **Match the tokens, not approximate them.** Use the design's resolved variables/tokens (colors, spacing, radius, font family/size/weight) exactly. Prefer the codebase's existing design-system tokens/components that correspond to them over hard-coded literals.
- **Reuse existing components.** Map a Figma component/variant to the repo's existing component of the same role before building a new one. Follow the project's established UI patterns (see *follow-existing-patterns*).
- **Fetch narrowly.** Pull only the node(s) you need. Design payloads are large — targeted fetches keep the change focused and the context budget intact.
- **Surface ambiguity, don't paper over it.** If the design and the written description conflict, or the design omits a state (hover/empty/error/loading) the ticket implies, call it out in the PR description rather than silently choosing.
- **Stay in scope.** Implement the referenced frames the ticket asks for; do not rebuild the entire design system because one screen referenced it.

If no design is referenced and no Figma tools are available, ignore this skill and proceed normally.`,
};
