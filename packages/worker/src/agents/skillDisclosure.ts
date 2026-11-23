import { z } from 'zod';
import type { AgentTracer } from '../lib/agentTracer.js';
import type { ResolvedSkill } from '../lib/config/agentSkills.js';
import { skillMenuLine, skillPromptBlock, skillToolText } from '../lib/config/skillPrompt.js';
import type { WorkerTool } from './workerTool.js';

/** The tool that discloses a skill's full text, on every loop that offers a menu. */
export const LOAD_SKILL_TOOL = 'loadSkill';

const loadSkillInputSchema = z.object({
  name: z.string().describe('Skill name from the skills menu'),
});
const loadSkillOutputSchema = z.object({ promptText: z.string() });

/**
 * The compact skill menu appended to a system prompt: name, description and
 * provenance only, so a session that never applies a skill never pays for its
 * text. The model calls `loadSkill` to read one.
 *
 * One writer for both runtimes: the Mastra loop binds `loadSkill` itself and Pi
 * gets the same tool through `workerTool.ts`, so an implementer session sees the
 * same menu and the same on-demand text whichever loop drives it. An agent node
 * or agent run inlines skill text on both loops instead (`composeAgentPrompt`)
 * and binds no menu.
 */
export function skillMenuSuffix(skills: readonly ResolvedSkill[]): string {
  if (skills.length === 0) {
    return '';
  }
  return [
    '## Available Skills',
    `Use the \`${LOAD_SKILL_TOOL}\` tool to load the full guidance for any skill before applying it.`,
    '',
    ...skills.map((s) => skillMenuLine(s)),
  ].join('\n');
}

/**
 * The `loadSkill` body: the full text of one menu entry, labelled as third-party
 * text when it was imported, or a message naming the skills that do exist. Each
 * call is traced like any other tool call.
 */
export function loadSkillWorkerTool(
  skills: readonly ResolvedSkill[],
  tracer?: AgentTracer
): WorkerTool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    call: async (args) => {
      const name = String((args as { name?: unknown } | null)?.name ?? '');
      const start = Date.now();
      const skill = byName.get(name);
      if (!skill) {
        const result = {
          promptText: `Unknown skill: ${name}. Available: ${[...byName.keys()].join(', ')}`,
        };
        tracer?.addToolCall({
          durationMs: Date.now() - start,
          inputJson: { name },
          outputJson: result,
          toolName: LOAD_SKILL_TOOL,
        });
        return result;
      }
      const result = { promptText: skillPromptBlock(skill) };
      tracer?.addToolCall({
        durationMs: Date.now() - start,
        inputJson: { name },
        outputJson: result,
        toolName: LOAD_SKILL_TOOL,
      });
      return result;
    },
    description:
      'Load the full guidance text for an available skill by name. ' +
      'Call this when you want to apply a specific skill from the skills menu.',
    inputSchema: loadSkillInputSchema,
    name: LOAD_SKILL_TOOL,
    outputSchema: loadSkillOutputSchema,
    // The result is prose the model reads as guidance, not data: send it as text.
    toText: (result) => skillToolText(result as { promptText: string }),
  };
}
