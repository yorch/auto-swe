/**
 * createChannelWorkflowDraft — the Slack channel-assistant path for natural-language
 * workflow authoring.
 *
 * When the channel assistant's `generateWorkflow` tool fires, the workflow calls
 * this activity to generate a {@link WorkflowSpec} from the user's description
 * (reusing the shared {@link generateWorkflowSpec} loop) and persist it as a DRAFT
 * WorkflowTemplate scoped to the channel's team — so a human reviews/activates it
 * on the canvas, exactly like the web + CLI paths. Persistence + the shell-refusal
 * + name-collision rules live in the shared {@link persistDraftTemplate} activity.
 *
 * Best-effort: returns `null` on any failure so the channel turn can post a
 * friendly "couldn't build that" note instead of erroring the whole run.
 */

import { prisma } from '@auto-swe/shared/db';
import { heartbeat } from '@temporalio/activity';
import { generateWorkflowSpec } from './generateWorkflowSpec.js';
import { persistDraftTemplate } from './persistDraftTemplate.js';

export interface CreateChannelWorkflowDraftInput {
  channelId: string;
  teamId: string;
  description: string;
  name?: string;
  /**
   * The Slack thread this draft was requested in. When set, the new template is
   * linked to the thread (ChannelThreadSession.lastGeneratedTemplateId) so a
   * follow-up "refine" in the same thread targets it.
   */
  threadTs?: string;
}

export interface CreateChannelWorkflowDraftResult {
  templateId: string;
  name: string;
  summary: string;
}

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
    const persisted = await persistDraftTemplate({
      name: input.name,
      spec: generated.spec,
      teamId: input.teamId,
    });
    if (!persisted) {
      // null = the spec contained shell/containerStep nodes the channel path
      // can't author (name collisions are handled by suffix-retry, not null).
      console.warn(
        `[channelAssistant] could not persist channel-authored draft for ${input.channelId} (shell/containerStep nodes)`
      );
      return null;
    }
    // Link the draft to the thread so a follow-up "refine" targets it. Best-effort:
    // a failure here just means the next refine reports "nothing to refine yet".
    if (input.threadTs) {
      try {
        await prisma.channelThreadSession.upsert({
          create: {
            channelId: input.channelId,
            lastGeneratedTemplateId: persisted.templateId,
            threadTs: input.threadTs,
          },
          update: { lastGeneratedTemplateId: persisted.templateId },
          where: {
            channelId_threadTs: { channelId: input.channelId, threadTs: input.threadTs },
          },
        });
      } catch (linkErr) {
        console.error(
          `[channelAssistant] could not link draft ${persisted.templateId} to thread for ${input.channelId}:`,
          linkErr instanceof Error ? linkErr.message : linkErr
        );
      }
    }
    return { name: persisted.name, summary: generated.summary, templateId: persisted.templateId };
  } catch (err) {
    console.error(
      `[channelAssistant] workflow draft generation failed for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
    return null;
  }
}
