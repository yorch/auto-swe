import type { WorkflowSpec } from '@auto-swe/shared/workflow';
import type { FastifyInstance } from 'fastify';
import type { JwtPayload } from '../plugins/auth.js';
import {
  createTemplateWithInitialVersion,
  resolveTemplateAuthScope,
  templateAuditFields,
} from '../routes/workflowTemplates.js';
import { advisoryWarnings } from './advisoryWarnings.js';
import { writeAuditLog } from './auditLog.js';
import { type PlanRefusal, refuse } from './runPlanService.js';
import {
  assertShellAuthoringAllowed,
  assertShellImagesAllowed,
  collectAuthoredCode,
  parseSpec,
  specValidationWarnings,
} from './specCheck.js';
import { validateSpecRefs } from './specRefValidation.js';
import { isReservedTemplateName } from './systemTemplate.js';
import { RESERVED_TEMPLATE_NAME_MESSAGE } from './templateSaveCheck.js';

/**
 * Saving a run plan as a workflow template: the plan's stored spec becomes a DRAFT template in the
 * plan's team, through the same persistence helper the workflow author's `POST /generate` uses.
 *
 * The version is marked `generatedBy` and `createdBy` the plan's owner, exactly as a generated draft
 * is, so the review rule applies unchanged: nobody but a platform ADMIN may review their own
 * generated version, and a generated version cannot be promoted, activated or made an experiment arm
 * until someone has reviewed it. The template is never the default and carries no bundle or system
 * origin.
 */

/** The `generatedBy` marker a template version saved from a run plan carries. */
export const RUN_PLAN_GENERATED_BY = 'run_plan';

/** What a plan's owner may save: not scrubbed (no spec), not rejected, not expired. */
export function planSaveBlock(
  plan: { status: string; expiresAt: Date; scrubbedAt: Date | null },
  now: Date = new Date()
): PlanRefusal | null {
  if (plan.scrubbedAt) {
    return refuse(
      409,
      'PLAN_SCRUBBED',
      'This plan was removed after it launched and no longer has a body to save'
    );
  }
  // A pending or approved plan past its expiry is expired in fact, whether or not the sweep has
  // marked it yet; a launched plan never expires.
  const lapsed =
    (plan.status === 'PENDING' || plan.status === 'APPROVED') &&
    plan.expiresAt.getTime() <= now.getTime();
  if (plan.status === 'REJECTED' || plan.status === 'EXPIRED' || lapsed) {
    return refuse(
      409,
      'PLAN_NOT_SAVEABLE',
      'A rejected or expired plan cannot be saved as a template'
    );
  }
  return null;
}

export type SaveRunPlanResult =
  | {
      ok: true;
      templateId: string;
      name: string;
      version: number;
      status: 'DRAFT';
      teamId: string;
      warnings: string[];
    }
  | (PlanRefusal & { body?: unknown });

/**
 * Save `plan` (already loaded, owned by `user`, and past the status checks) as a DRAFT template.
 * A refusal either is a `PlanRefusal` or carries the exact `body` another route would have sent
 * (the author-role refusal, the shell gates).
 */
export async function saveRunPlanAsTemplate(
  fastify: FastifyInstance,
  user: JwtPayload,
  plan: { id: string; teamId: string; mode: string; spec: unknown },
  requestedName: string | undefined
): Promise<SaveRunPlanResult> {
  // The template-authoring role of the plan's team, by the helper `POST /workflow-templates`
  // and `POST /generate` use.
  const scope = await resolveTemplateAuthScope(fastify, user, plan.teamId);
  if (!scope.ok) {
    const error = (scope.body as { error?: { code?: string; message?: string } }).error;
    return {
      body: scope.body,
      code: error?.code ?? 'FORBIDDEN',
      message:
        error?.message ?? 'Requires LEAD membership on an active team to author its templates',
      ok: false,
      status: scope.statusCode,
    };
  }

  // The stored spec goes through the strict parse every save runs.
  const parsed = parseSpec(plan.spec);
  if (!parsed.ok) {
    return refuse(400, 'INVALID_SPEC', parsed.message);
  }
  const spec: WorkflowSpec = parsed.spec;
  if (requestedName !== undefined) {
    // Keep the template and its spec's name aligned, as the generate route does.
    spec.name = requestedName;
  }
  const name = spec.name;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 120) {
    return refuse(
      400,
      'TEMPLATE_NAME_INVALID',
      'The template needs a name of 1 to 120 characters; pass "name"'
    );
  }
  if (isReservedTemplateName(name)) {
    return refuse(400, 'RESERVED_TEMPLATE_NAME', RESERVED_TEMPLATE_NAME_MESSAGE);
  }

  // The shell gates a save runs. A plan carries no shell node, but a stored spec is checked, not
  // assumed.
  const { authoredNodes, shellNodes } = collectAuthoredCode(spec);
  const [rbac, imgGate] = await Promise.all([
    assertShellAuthoringAllowed(fastify, user, plan.teamId, authoredNodes),
    assertShellImagesAllowed(fastify, plan.teamId, shellNodes),
  ]);
  const gate = rbac ?? (imgGate.ok ? null : imgGate);
  if (gate) {
    const error = (gate.body as { error?: { code?: string; message?: string } }).error;
    return {
      body: gate.body,
      code: error?.code ?? 'FORBIDDEN',
      message: error?.message ?? 'Not allowed',
      ok: false,
      status: gate.statusCode,
    };
  }
  const egressAllowlist = imgGate.ok ? imgGate.egressAllowlist : [];

  let tpl: Awaited<ReturnType<typeof createTemplateWithInitialVersion>>;
  try {
    tpl = await createTemplateWithInitialVersion(fastify.prisma, {
      auditNodes: authoredNodes,
      authorUserId: user.sub,
      description: spec.description ?? '',
      egressAllowlist,
      generatedBy: RUN_PLAN_GENERATED_BY,
      name,
      specJson: spec as object,
      status: 'DRAFT',
      teamId: plan.teamId,
      // Planned runs always launch with a repository checkout (`git_repo`), output-only plans
      // included, and an agent node of either may use `workspace: true`; a null provider would
      // fail that at run time without a connection.
      workspaceProvider: 'git_repo',
    });
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'P2002') {
      return refuse(
        409,
        'NAME_CONFLICT',
        `A template named "${name}" already exists in this team. Choose another name.`
      );
    }
    throw err;
  }

  await writeAuditLog(fastify, {
    action: 'CREATE',
    actor: user,
    after: {
      ...templateAuditFields(tpl),
      generatedBy: RUN_PLAN_GENERATED_BY,
      sourceRunPlanId: plan.id,
    },
    entityId: tpl.id,
    entityType: 'WorkflowTemplate',
  });

  const warnings = [
    ...(await advisoryWarnings(
      'workflow spec references',
      () => validateSpecRefs(fastify.prisma, spec, plan.teamId),
      []
    )),
    ...specValidationWarnings(spec),
  ];
  return {
    name: tpl.name,
    ok: true,
    status: 'DRAFT',
    teamId: plan.teamId,
    templateId: tpl.id,
    // A new template's initial version is always 1.
    version: 1,
    warnings,
  };
}
