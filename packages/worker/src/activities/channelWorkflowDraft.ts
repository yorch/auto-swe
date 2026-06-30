/**
 * createChannelWorkflowDraft — the Slack channel-assistant path for natural-language
 * workflow authoring.
 *
 * When the channel assistant's `generateWorkflow` tool fires, the workflow calls
 * this activity to generate a {@link WorkflowSpec} from the user's description
 * (reusing the shared {@link generateWorkflowSpec} loop) and persist it as a DRAFT
 * WorkflowTemplate scoped to the channel's team — so a human reviews/activates it
 * on the canvas, exactly like the web + CLI paths. Channel-authored drafts never
 * contain shell nodes (`allowShell: false`), so no shell RBAC/audit applies here.
 *
 * Best-effort: returns `null` on any failure so the channel turn can post a
 * friendly "couldn't build that" note instead of erroring the whole run.
 */

import { prisma } from '@auto-swe/shared/db';
import { heartbeat } from '@temporalio/activity';
import { generateWorkflowSpec } from './generateWorkflowSpec.js';

export interface CreateChannelWorkflowDraftInput {
  channelId: string;
  teamId: string;
  description: string;
  name?: string;
}

export interface CreateChannelWorkflowDraftResult {
  templateId: string;
  name: string;
  summary: string;
}

/** Bounded suffix retries when a generated name collides with an existing one. */
const MAX_NAME_ATTEMPTS = 5;

export async function createChannelWorkflowDraft(
  input: CreateChannelWorkflowDraftInput
): Promise<CreateChannelWorkflowDraftResult | null> {
  try {
    heartbeat('channel workflow draft: generating');
    const generated = await generateWorkflowSpec({
      allowShell: false,
      prompt: input.description,
      teamId: input.teamId,
    });
    const spec = generated.spec;
    const baseName = input.name?.trim() || spec.name;

    // (teamId, name) is unique — retry with a numeric suffix on collision so a
    // channel-authored draft never fails just because the name is taken.
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
      const name = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
      spec.name = name;
      try {
        const created = await prisma.workflowTemplate.create({
          data: {
            activeVersion: 1,
            description: spec.description ?? '',
            name,
            status: 'DRAFT',
            teamId: input.teamId,
            versions: { create: { spec: spec as object, version: 1 } },
          },
        });
        return { name, summary: generated.summary, templateId: created.id };
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'P2002' || attempt === MAX_NAME_ATTEMPTS - 1) {
          throw err;
        }
      }
    }
    return null;
  } catch (err) {
    console.error(
      `[channelAssistant] workflow draft generation failed for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
