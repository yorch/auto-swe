import type { ResolvedSkill } from './types.js';

/**
 * The one place a resolved skill is turned into text a model reads.
 *
 * A skill imported from an external source carries `provenance`
 * (`external: owner/repo@sha7`), and every route its text takes to a model must
 * say so, not just the implementer's menu: the harness runtime, the review
 * personas, the generic `runAgent`, the planner and decomposer, the memory
 * agents, the security reviewer and `loadSkill` all go through here.
 * `skillPromptSites.test.ts` fails if a new site reads `.promptText` directly.
 */

/** A skill's text for a prompt, labelled as third-party when it was imported. */
export function skillPromptBlock(s: Pick<ResolvedSkill, 'promptText' | 'provenance'>): string {
  return s.provenance ? `[${s.provenance} — third-party text]\n${s.promptText}` : s.promptText;
}

/** Blocks for every skill with text, joined by a blank line; '' when there is none. */
export function joinSkillPrompts(skills: Array<Pick<ResolvedSkill, 'promptText' | 'provenance'>>) {
  return skills
    .filter((s) => s.promptText)
    .map(skillPromptBlock)
    .join('\n\n');
}

/** One entry of the skill menu, with the same provenance label in front of the description. */
export function skillMenuLine(
  s: Pick<ResolvedSkill, 'name' | 'description' | 'provenance'>
): string {
  const tag = s.provenance ? `[${s.provenance}] ` : '';
  return `- **${s.name}**: ${tag}${s.description || s.name}`;
}

/**
 * A `loadSkill` result as the text a harness's tool message carries. The result
 * was rendered by {@link skillPromptBlock}, so this is a pass-through — and the
 * read lives here, beside the renderer, rather than at a runtime's tool binding
 * that would then be a second site skill text leaves through.
 */
export function skillToolText(result: { promptText: string }): string {
  return result.promptText;
}
