import crypto from 'node:crypto';
import type { Prisma, Role } from '@auto-swe/shared';
import { isGitRepoConnection } from '@auto-swe/shared/lib/connectionGuards';
import {
  declaredConnectionInputs,
  isInputSchema,
  validateInputPayload,
} from '@auto-swe/shared/lib/inputSchema';
import { resolveRepoAccessGateOrLastKnown } from '@auto-swe/shared/lib/repoAccessGate';
import { repoMembersSelect } from '@auto-swe/shared/lib/repoMembership';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import {
  generateBranchName,
  generateWorkflowId,
  legacyWorkflowIdBases,
} from '@auto-swe/shared/lib/workflowId';
import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import type { FastifyInstance } from 'fastify';
import { resolveDefaultTemplate } from '../../routes/workRequests.js';
import { authorizeLaunch, launchRefusalMessage } from '../launchAuthorization.js';
import { asPlatformAdmin } from '../platformAdminScope.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../systemTemplate.js';
import { memberTeams, reachableConnections } from '../tenantScope.js';
import { isValidTicketId, MAX_DESCRIPTION_LENGTH } from '../ticketId.js';
import { allocateWorkflowId, launchTrackedWorkflow } from '../workflowLaunch.js';
import { listVisibleTemplates } from './slashCommands.js';
import type { SlackInteractivePayload } from './types.js';

// ── Modal: work-request picker ──────────────────────────────────────────────

interface SlackModalView {
  blocks: Array<{ text: { text: string; type: 'mrkdwn' }; type: 'section' }>;
  close: { text: string; type: 'plain_text' };
  title: { text: string; type: 'plain_text' };
  type: 'modal';
}

interface RunModalMetadata {
  channelId: string;
  initialDescription: string;
}

/**
 * A minimal info modal shown when an unlinked Slack user triggers the global
 * "Run a workflow" shortcut. Unlike a slash command or message action, a global
 * shortcut carries no channel/response_url, so an ephemeral hint can't reach the
 * clicker — this modal is the only surface available via the `trigger_id`.
 */
export function buildLinkAccountModalView(): SlackModalView {
  return {
    blocks: [
      {
        text: {
          text: 'Link your Slack account in *Settings → Slack* first, then trigger this shortcut again to pick a workflow to run.',
          type: 'mrkdwn',
        },
        type: 'section',
      },
    ],
    close: { text: 'Close', type: 'plain_text' },
    title: { text: 'auto-swe', type: 'plain_text' },
    type: 'modal',
  };
}

export async function buildRunModalView(
  fastify: FastifyInstance,
  user: { id: string; role: Role },
  channelId: string,
  initialDescription: string
): Promise<{ ok: true; view: unknown } | { ok: false; error: string }> {
  const tpls = await listVisibleTemplates(fastify, user);
  // A listing, so the decision belongs in the query. It used to load every
  // active repository and filter on selected membership rows, which offered a
  // picker containing repositories the user had lost GitHub access to — the
  // names alone are a leak, and picking one only failed at submit.
  const gate = (await resolveRepoAccessGateOrLastKnown()) ?? undefined;
  const where: Prisma.ConnectionWhereInput = {
    isActive: true,
    // Only git_repo connections are valid run targets; exclude non-git types (e.g. mcp).
    type: 'git_repo',
    ...(user.role !== 'ADMIN' && reachableConnections({ sub: user.id }, gate)),
  };
  const accessibleRepos = await asPlatformAdmin(
    user,
    "admin picks from every team's repos",
    ['Connection'],
    () =>
      fastify.prisma.connection.findMany({
        select: { id: true, organizationName: true, repoName: true },
        where,
      })
  );
  // The submission handler binds the repo via `selected_option.value` on a
  // `static_select` element — rendering a free-text fallback would silently
  // skip submission validation, so we short-circuit when there's nothing to
  // pick. Caller surfaces this as an ephemeral message.
  if (accessibleRepos.length === 0) {
    return {
      // Two causes, and telling someone to ask an admin is wrong for the
      // second: they may not be on a team, or the GitHub permission gate may be
      // enforcing before the sweep has recorded any answers for them, in which
      // case being added to a team changes nothing.
      error:
        gate?.mode === 'enforce'
          ? 'No repositories available. Either you are not on a team that owns one, or your GitHub access has not been confirmed yet — it is checked periodically, so try again shortly.'
          : 'You do not have access to any active repositories. Ask a team admin to add you.',
      ok: false,
    };
  }

  const repoOptions = accessibleRepos.slice(0, 100).map((r) => ({
    text: { text: `${r.organizationName}/${r.repoName}`, type: 'plain_text' as const },
    value: r.id,
  }));
  const tplOptions = [
    { text: { text: '(team default)', type: 'plain_text' as const }, value: '' },
    ...tpls.slice(0, 100).map((t) => ({
      text: {
        text: `${t.name}${t.isDefault ? ' (default)' : ''}`,
        type: 'plain_text' as const,
      },
      value: t.id,
    })),
  ];

  const metadata: RunModalMetadata = { channelId, initialDescription };

  const view = {
    blocks: [
      {
        block_id: 'ticket_block',
        element: {
          action_id: 'ticket_input',
          placeholder: { text: 'e.g. JIRA-1234', type: 'plain_text' },
          type: 'plain_text_input',
        },
        label: { text: 'Ticket ID', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: 'description_block',
        element: {
          action_id: 'description_input',
          ...(initialDescription ? { initial_value: initialDescription } : {}),
          multiline: true,
          placeholder: { text: 'What should the agent build?', type: 'plain_text' },
          type: 'plain_text_input',
        },
        label: { text: 'Description', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: 'repo_block',
        element: {
          action_id: 'repo_select',
          options: repoOptions,
          placeholder: { text: 'Select a repository', type: 'plain_text' },
          type: 'static_select',
        },
        label: { text: 'Repository', type: 'plain_text' },
        type: 'input',
      },
      {
        block_id: 'template_block',
        element: {
          action_id: 'template_select',
          initial_option: tplOptions[0],
          options: tplOptions,
          type: 'static_select',
        },
        label: { text: 'Workflow', type: 'plain_text' },
        optional: true,
        type: 'input',
      },
    ],
    callback_id: 'auto_swe_run_modal',
    close: { text: 'Cancel', type: 'plain_text' },
    private_metadata: JSON.stringify(metadata),
    submit: { text: 'Run', type: 'plain_text' },
    title: { text: 'Run a workflow', type: 'plain_text' },
    type: 'modal',
  };
  return { ok: true, view };
}

export async function handleRunModalSubmission(
  fastify: FastifyInstance,
  user: { id: string; role: Role },
  payload: SlackInteractivePayload
): Promise<unknown> {
  const values = payload.view?.state?.values ?? {};
  const ticket = (values.ticket_block?.ticket_input?.value ?? '').trim();
  const description = (values.description_block?.description_input?.value ?? '').trim();
  const repoId = values.repo_block?.repo_select?.selected_option?.value ?? '';
  const templateId = values.template_block?.template_select?.selected_option?.value ?? '';

  const errors: Record<string, string> = {};
  if (!ticket) {
    errors.ticket_block = 'Ticket ID is required';
  } else if (!isValidTicketId(ticket)) {
    // The ticket id becomes the branch name and part of the Temporal workflow
    // id, so it takes the same validation as POST /work-requests.
    errors.ticket_block =
      'Ticket ID may only contain letters, digits, ".", "_", "#", "/" and "-" (max 100)';
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.description_block = `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`;
  }
  if (!description) {
    errors.description_block = 'Description is required';
  }
  if (!repoId) {
    errors.repo_block = 'Repository is required';
  }
  if (Object.keys(errors).length > 0) {
    return { errors, response_action: 'errors' };
  }

  let metadata: RunModalMetadata = { channelId: '', initialDescription: '' };
  try {
    metadata = JSON.parse(payload.view?.private_metadata ?? '{}') as RunModalMetadata;
  } catch {
    /* keep defaults */
  }

  const repo = await fastify.prisma.connection.findUnique({
    include: {
      installation: { select: { host: true, installationId: true, isActive: true } },
      shares: repoMembersSelect({ userId: true }, { userId: user.id }).shares,
      team: {
        select: {
          memberships: { select: { userId: true }, where: { userId: user.id } },
          organization: { select: { id: true, monthlyBudgetUsdCents: true } },
          orgId: true,
        },
      },
    },
    where: { id: repoId },
  });
  if (!repo?.isActive) {
    return {
      errors: { repo_block: 'Repository not found or inactive' },
      response_action: 'errors',
    };
  }
  if (!isGitRepoConnection(repo)) {
    return {
      errors: { repo_block: 'Selected connection is not a git repository' },
      response_action: 'errors',
    };
  }

  // Team membership and GitHub permission in one decision, the same one the
  // dashboard's submit takes. Slack routes authenticate by request signature
  // rather than `requireAuth`, so the gate is resolved here.
  const gate = await resolveRepoAccessGateOrLastKnown();
  if (!gate) {
    // A launch must never be more permissive than a steer of the run it starts.
    // The rest of the gateway reads a never-readable gate as `off`, which is
    // defensible where it decorates every authenticated request and the routes
    // downstream still check team membership — but this route authenticates by
    // request signature, so the gate read is the only policy in the path, and
    // it is the strictly more powerful operation.
    return {
      errors: {
        repo_block:
          'Cannot start a run right now — the access policy could not be read. Try again shortly.',
      },
      response_action: 'errors',
    };
  }
  // Repository access, org membership and the org's monthly cap — the same
  // launch decision the dashboard's submit takes.
  const authorization = await authorizeLaunch(
    fastify.prisma,
    { role: user.role, sub: user.id },
    {
      gate,
      repos: [repo],
      // The run is launched as the linked platform user (`launchedById` below),
      // so it may use their own saved token and the gate judges that token.
      runIdentity: 'caller',
    }
  );
  if (!authorization.ok) {
    return {
      errors: { repo_block: launchRefusalMessage(authorization.refusal) },
      response_action: 'errors',
    };
  }

  // Resolve workflow template — explicit choice wins, else default resolver.
  let resolvedTemplate: { templateId: string; version: number } | null = null;
  if (templateId) {
    // Same visibility rule as the picker that offered the option (and as
    // POST /workflow-templates/:id/runs): a tampered client cannot launch a
    // template the user cannot see or one that is not active.
    const tpl = await fastify.prisma.workflowTemplate.findFirst({
      where: {
        id: templateId,
        status: 'ACTIVE',
        ...EXCLUDE_SYSTEM_TEMPLATES,
        ...(user.role === 'ADMIN'
          ? {}
          : { AND: [{ OR: [{ teamId: null }, { team: memberTeams({ sub: user.id }) }] }] }),
      },
    });
    if (!tpl?.activeVersion) {
      return {
        errors: { template_block: 'Selected workflow has no active version' },
        response_action: 'errors',
      };
    }
    resolvedTemplate = { templateId: tpl.id, version: tpl.activeVersion };
  } else {
    const def = await resolveDefaultTemplate(fastify.prisma, repo.teamId, ticket);
    if (!def) {
      return {
        errors: { template_block: 'No default workflow template configured for this team' },
        response_action: 'errors',
      };
    }
    resolvedTemplate = { templateId: def.templateId, version: def.version };
  }

  // The same payload contract POST /work-requests validates against the
  // template's declared input schema, checked before any ledger row is written.
  const requestPayload = JSON.stringify({ description, externalTicketId: ticket, source: 'slack' });
  const runPayload = {
    budget: 'STANDARD',
    connectionId: repo.id,
    description,
    ticketId: ticket,
  };
  const tplSchema = await fastify.prisma.workflowTemplate.findUnique({
    select: { inputSchema: true },
    where: { id: resolvedTemplate.templateId },
  });
  if (tplSchema?.inputSchema && isInputSchema(tplSchema.inputSchema)) {
    const result = validateInputPayload(tplSchema.inputSchema, runPayload);
    if (!result.ok) {
      return {
        errors: {
          template_block: `This workflow needs inputs the modal cannot supply: ${result.errors.join('; ')}`,
        },
        response_action: 'errors',
      };
    }
    // The modal fills exactly four keys — `budget`, `connectionId`, `description`, `ticketId` —
    // so a template that types one of them as a `connection` lets the *submitter* name a
    // connection the run then uses: the payload is where the run's authorized set comes from, and
    // nothing between here and the worker decides the connections it declares. `connectionId` is
    // the repository this launch already decided; every other connection-typed field this payload
    // fills is refused, as is a `connectionId` whose declared type contradicts that repository.
    const declared = declaredConnectionInputs(tplSchema.inputSchema, runPayload);
    const unexpected = declared.find((field) => field.connectionId !== repo.id);
    const mismatched = declared.find(
      (field) =>
        field.connectionId === repo.id && field.expectedType && field.expectedType !== repo.type
    );
    if (unexpected || mismatched) {
      return {
        errors: {
          template_block: unexpected
            ? `This workflow cannot be run from Slack: '${unexpected.field}' is a connection input`
            : 'This workflow expects a different kind of connection than the repository you chose',
        },
        response_action: 'errors',
      };
    }
  }

  // Re-submitting a finished ticket gets an `-rN` suffix, exactly as the
  // dashboard does; a base id alone would collide with the finished run's
  // ledger row and leave the ticket unsubmittable from Slack.
  // The current id; a run still in flight under an id the ticket had in an
  // earlier format (stored casing, no host) blocks a second one.
  const allocated = await allocateWorkflowId(
    fastify.prisma,
    generateWorkflowId(ticket, repo.organizationName, repo.repoName, repo.githubUrl),
    { externalTicketId: ticket, repoId: repo.id },
    legacyWorkflowIdBases(ticket, repo.organizationName, repo.repoName, repo.githubUrl)
  );
  if ('conflictWorkflowId' in allocated) {
    return {
      errors: {
        ticket_block: allocated.conflictOtherRow
          ? `Workflow already running for ${ticket} for this repository`
          : `Workflow already running for ${ticket} (${allocated.conflictWorkflowId})`,
      },
      response_action: 'errors',
    };
  }
  const temporalWorkflowId = allocated.workflowId;
  const { branchPrefix: slackBranchPrefix } = await resolveWorkflowDefaults();
  const branch = generateBranchName(ticket, slackBranchPrefix);
  const workRequestId = crypto.randomUUID();
  const repoWorkRequest: RepoWorkRequest = {
    budgetTier: 'STANDARD',
    description,
    externalTicketId: ticket,
    // The Slack request is signature-verified and the account link names the
    // platform user, the same identity the access gate above judged.
    launchedById: user.id,
    repoId: repo.id,
    requestPayload,
    workRequestId,
  };

  // Ledger rows first, workflow second, rolled back if the start fails —
  // see `launchTrackedWorkflow`. The unique index on the allocated workflow ID
  // is the real dedup gate, so a double-submitted modal loses the race rather
  // than starting a second run.
  const launch = await launchTrackedWorkflow(
    fastify.prisma,
    {
      activeWorkflow: {
        assignedBranch: branch,
        budgetTier: 'STANDARD',
        currentStatus: 'IMPLEMENTING',
        repoId: repo.id,
        temporalWorkflowId,
        workRequestId,
      },
      knowledgeSourceRepo: {
        orgId: repo.team.orgId,
        repoId: repo.id,
        teamId: repo.teamId,
      },
      runInput: {
        connectionId: repo.id,
        description,
        externalTicketId: ticket,
        id: workRequestId,
        payload: runPayload,
        requestedById: user.id,
        requestPayload,
        slackChannelId: metadata.channelId || null,
        templateId: resolvedTemplate.templateId,
        templateVersion: resolvedTemplate.version,
      },
    },
    () =>
      fastify.temporal.startRunnableWorkflow(temporalWorkflowId, {
        request: repoWorkRequest,
        templateId: resolvedTemplate.templateId,
        templateVersion: resolvedTemplate.version,
      }),
    {
      log: fastify.log,
      sourceAuthorization: { actor: { role: user.role, sub: user.id } },
    }
  );
  if (!launch.ok) {
    return {
      errors: { ticket_block: `Workflow already running for ${ticket}` },
      response_action: 'errors',
    };
  }

  // Closing the modal with no `response_action` dismisses it cleanly.
  return { response_action: 'clear' };
}
