import type { InputSchema } from '@auto-swe/shared/lib/inputSchema';

/**
 * Starter text for the Start work forms. A sample only fills fields; it never launches anything,
 * and the user still reviews the details before launching. The agent sample asks for a read-only
 * explanation. The epic and workflow samples ask for a small documentation change, which a
 * launched run can turn into a real pull request, so the review screen is the last stop.
 */

/** A read-only prompt: it asks for an explanation and tells the agent not to edit files. */
export const AGENT_SAMPLE_PROMPT =
  'Explain how this repository is organised. List the main directories and what each is for, ' +
  'how to install dependencies, build it and run its tests, and where a new contributor should ' +
  'start reading. Do not change any files.';

/** A small documentation change across repositories; the user still picks the repositories. */
export const EPIC_SAMPLE = {
  description:
    'Add a short "Troubleshooting" section to the README of each repository, covering the most ' +
    'common problem a new contributor hits when setting the project up.',
} as const;

/**
 * A fresh placeholder ticket id for each fill. An epic's workflow id is `epic-<ticket id>` and its
 * branches derive from the ticket id, so a fixed id would make the second sample launch fail as an
 * already-existing epic.
 */
export function sampleEpicTicketId(random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0')
    .toUpperCase();
  return `DOCS-SAMPLE-${suffix}`;
}

/** The task name and free-text input for a workflow whose schema has a matching field. */
export const WORKFLOW_SAMPLE = {
  label: 'Sample task',
  text: 'Add a short "Troubleshooting" section to the README that covers the most common setup problem.',
} as const;

/** Property names that read like a free-text task, best match first. */
const TASK_FIELD_NAMES = ['description', 'task', 'request', 'prompt', 'brief', 'goal', 'summary'];

/**
 * The one schema property a workflow sample may fill, or null. Only a plain free-text string
 * qualifies: no enum, no uuid format, no default. A schema with several plain strings is
 * filled only when one of them is named like a task; guessing which of `branch`, `title` and
 * `notes` takes a task description would put sample text in the wrong field.
 */
export function pickSampleField(schema: InputSchema | null): string | null {
  if (!schema) {
    return null;
  }
  const plain = Object.entries(schema.properties).filter(
    ([, prop]) =>
      prop.type === 'string' &&
      prop.format === undefined &&
      !(Array.isArray(prop.enum) && prop.enum.length > 0) &&
      prop.default === undefined
  );
  if (plain.length === 0) {
    return null;
  }
  for (const name of TASK_FIELD_NAMES) {
    const hit = plain.find(([key]) => key.toLowerCase() === name);
    if (hit) {
      return hit[0];
    }
  }
  return plain.length === 1 ? plain[0][0] : null;
}
