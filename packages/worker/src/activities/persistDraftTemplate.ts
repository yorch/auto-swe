/**
 * persistDraftTemplate — persist an AI-generated {@link WorkflowSpec} as a DRAFT
 * WorkflowTemplate (worker-side). Shared by the channel-assistant path and the
 * async generation job so the "create a DRAFT from a generated spec" rules live
 * in one place:
 *   - refuse shell/containerStep nodes (this path is never shell-authorized — it
 *     would bypass the gateway's shell RBAC + WorkflowShellAudit),
 *   - clamp the name to the 120-char spec cap,
 *   - retry with a numeric suffix on a (teamId, name) collision.
 *
 * Returns `null` when the spec contains shell nodes (caller surfaces a friendly
 * message); throws only on an unexpected DB error.
 */

import { prisma } from '@auto-swe/shared/db';
import type { WorkflowSpec } from '@auto-swe/shared/workflow';

export interface PersistDraftTemplateInput {
  spec: WorkflowSpec;
  /** Owning team, or null for a global (admin-authored) draft. */
  teamId: string | null;
  /** Optional name override; defaults to the spec's own name. */
  name?: string;
  /** Optional author user id recorded on the version row. */
  createdById?: string | null;
}

export interface PersistDraftTemplateResult {
  templateId: string;
  name: string;
}

/** Bounded suffix retries when a generated name collides with an existing one. */
const MAX_NAME_ATTEMPTS = 5;

export async function persistDraftTemplate(
  input: PersistDraftTemplateInput
): Promise<PersistDraftTemplateResult | null> {
  const spec = input.spec;

  // This path is never authorized for shell/containerStep (no RBAC + no audit
  // here). Refuse rather than persist an un-audited shell command.
  const hasShellNode = Object.values(spec.nodes).some(
    (n) => n.type === 'shell' || n.type === 'containerStep'
  );
  if (hasShellNode) {
    return null;
  }

  const baseName = input.name?.trim() || spec.name;

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
    // Keep the suffixed name within the WorkflowSpec 120-char `name` cap so the
    // persisted spec stays re-validatable (the canvas re-parses on save).
    const suffix = attempt === 0 ? '' : ` (${attempt + 1})`;
    const name = `${baseName.slice(0, 120 - suffix.length)}${suffix}`;
    // Persist a COPY with the resolved name — never mutate the caller's spec.
    const specToSave = { ...spec, name };
    try {
      const created = await prisma.workflowTemplate.create({
        data: {
          activeVersion: 1,
          description: spec.description ?? '',
          name,
          status: 'DRAFT',
          teamId: input.teamId,
          versions: {
            create: {
              createdBy: input.createdById ?? null,
              generatedBy: 'workflow_author',
              spec: specToSave as object,
              version: 1,
            },
          },
        },
      });
      return { name, templateId: created.id };
    } catch (err) {
      const code = (err as { code?: string }).code;
      // A name collision retries with a new suffix; the final attempt (and any
      // non-collision error) rethrows so the caller surfaces a real failure.
      if (code !== 'P2002' || attempt === MAX_NAME_ATTEMPTS - 1) {
        throw err;
      }
    }
  }
  // Unreachable (the loop returns or throws), but satisfies the type checker.
  return null;
}
