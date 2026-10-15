/**
 * refineChannelWorkflowDraft — the Slack channel-assistant path for
 * conversational workflow refinement.
 *
 * When the channel assistant's `refineWorkflow` tool fires (a follow-up like
 * "also add a security review step"), the workflow calls this activity to apply
 * the change to the draft the SAME thread generated earlier. The thread→template
 * link lives on {@link ChannelThreadSession.lastGeneratedTemplateId} (written by
 * {@link createChannelWorkflowDraft}); we load that template's latest version,
 * re-run the shared {@link generateWorkflowSpec} loop in refine mode (seeded with
 * the current spec), and save the result as a NEW version — so history is
 * preserved and a human still activates it on the canvas.
 *
 * Best-effort + status-typed so the workflow can post a precise message:
 *   - `no_target`  — this thread hasn't generated a workflow to refine.
 *   - `refined`    — a new version was saved.
 *   - `shell_refused` — the current draft or the refinement runs code an author
 *                    wrote (container code or an authored gate command), which the
 *                    channel path never authors; the change belongs on the canvas.
 *   - `failed`     — generation/validation failed.
 */

import { prisma } from '@auto-swe/shared/db';
import {
  hasAuthoredCode,
  migrateSpec,
  parseWorkflowSpec,
  SPEC_SCHEMA_VERSION,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import { heartbeat } from '@temporalio/activity';
import { generateWorkflowSpec } from './generateWorkflowSpec.js';

export interface RefineChannelWorkflowDraftInput {
  channelId: string;
  threadTs: string;
  teamId: string;
  /** The plain-language change to apply to the thread's current draft. */
  instruction: string;
}

export interface RefineChannelWorkflowDraftResult {
  status: 'refined' | 'no_target' | 'shell_refused' | 'failed';
  /** Present when `status === 'refined'`. */
  name?: string;
  version?: number;
  summary?: string;
}

/** Bounded retries for the racy max(version)+1 → insert. */
const MAX_VERSION_ATTEMPTS = 5;

/** Append a new version (max+1) to a template, retrying on the unique clash. */
async function appendVersion(templateId: string, spec: WorkflowSpec): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_VERSION_ATTEMPTS; attempt++) {
    const last = await prisma.workflowTemplateVersion.findFirst({
      orderBy: { version: 'desc' },
      select: { version: true },
      where: { templateId },
    });
    const next = (last?.version ?? 0) + 1;
    try {
      await prisma.workflowTemplateVersion.create({
        // The workflow author agent wrote this spec, so the version says so:
        // `generatedBy` is what requires a human review before it can be
        // promoted, and a version with neither `createdBy` nor `generatedBy`
        // is what `syncBuiltins` takes for a built-in one.
        data: {
          createdBy: null,
          generatedBy: 'workflow_author',
          spec: spec as object,
          templateId,
          version: next,
        },
      });
      return next;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'P2002' || attempt === MAX_VERSION_ATTEMPTS - 1) {
        throw err;
      }
    }
  }
  return null;
}

export async function refineChannelWorkflowDraft(
  input: RefineChannelWorkflowDraftInput
): Promise<RefineChannelWorkflowDraftResult> {
  try {
    heartbeat('channel workflow refine: resolving target');
    const session = await prisma.channelThreadSession.findUnique({
      select: { lastGeneratedTemplateId: true },
      where: {
        channelId_threadTs: { channelId: input.channelId, threadTs: input.threadTs },
      },
    });
    const templateId = session?.lastGeneratedTemplateId;
    if (!templateId) {
      return { status: 'no_target' };
    }

    const tpl = await prisma.workflowTemplate.findUnique({
      select: { id: true, name: true, teamId: true },
      where: { id: templateId },
    });
    const latest = tpl
      ? await prisma.workflowTemplateVersion.findFirst({
          orderBy: { version: 'desc' },
          where: { templateId: tpl.id },
        })
      : null;
    if (!tpl || !latest) {
      // The linked template was deleted — nothing to refine.
      return { status: 'no_target' };
    }

    let baseSpec: WorkflowSpec;
    try {
      baseSpec = parseWorkflowSpec(migrateSpec(latest.spec, SPEC_SCHEMA_VERSION));
    } catch {
      return { status: 'failed' };
    }

    // A draft edited on the canvas may already carry container code or an authored
    // command. The refinement returns the full spec, so it would carry them too and be
    // refused below — say so now rather than spend a generation on it.
    if (hasAuthoredCode(baseSpec)) {
      return { status: 'shell_refused' };
    }

    heartbeat('channel workflow refine: generating');
    const generated = await generateWorkflowSpec({
      allowShell: false,
      baseSpec,
      prompt: input.instruction,
      teamId: input.teamId,
    });

    // The channel path is never shell-authorized (no RBAC + no audit here), so a
    // refinement that introduces container code (a `shell` or `containerStep` node, or
    // a `step` naming `runContainerStep`) or an authored gate command is refused; the
    // user must make that change on the canvas.
    if (hasAuthoredCode(generated.spec)) {
      return { status: 'shell_refused' };
    }

    // Pin the name to the existing template so a refinement can't rename it.
    const spec: WorkflowSpec = { ...generated.spec, name: tpl.name };
    const version = await appendVersion(tpl.id, spec);
    if (version == null) {
      return { status: 'failed' };
    }
    return { name: tpl.name, status: 'refined', summary: generated.summary, version };
  } catch (err) {
    console.error(
      `[channelAssistant] workflow refinement failed for ${input.channelId}:`,
      err instanceof Error ? err.message : err
    );
    return { status: 'failed' };
  }
}
