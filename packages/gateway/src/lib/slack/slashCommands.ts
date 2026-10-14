import type { Role } from '@auto-swe/shared';
import type { FastifyInstance } from 'fastify';
import { asPlatformAdmin } from '../platformAdminScope.js';
import { EXCLUDE_SYSTEM_TEMPLATES } from '../systemTemplate.js';
import { memberTeams } from '../tenantScope.js';

// ── Slash-command helpers ───────────────────────────────────────────────────

export function ephemeral(text: string): { response_type: 'ephemeral'; text: string } {
  return { response_type: 'ephemeral', text };
}

export function slashHelpText(): string {
  return [
    '*auto-swe slash commands*',
    '• `/auto-swe workflows list` — list workflow templates visible to you',
    '• `/auto-swe workflows show <name>` — show one template (active version)',
    '• `/auto-swe run [description]` — open a work-request modal (workflow picker)',
    '• `/auto-swe help` — this message',
  ].join('\n');
}

interface SimpleTemplateRow {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  activeVersion: number | null;
  team: { id: string; slug: string; name: string } | null;
}

export async function listVisibleTemplates(
  fastify: FastifyInstance,
  user: { id: string; role: Role }
): Promise<SimpleTemplateRow[]> {
  const visible =
    user.role === 'ADMIN'
      ? {}
      : {
          OR: [{ teamId: null }, { team: memberTeams({ sub: user.id }) }],
        };
  // System templates ("Agent Run") are never offered, whoever is asking.
  const where = { AND: [visible, EXCLUDE_SYSTEM_TEMPLATES] };
  // `where` is only the visibility rule for a platform admin — the deliberate cross-tenant branch.
  const rows = await asPlatformAdmin(
    user,
    "admin lists every team's templates",
    ['WorkflowTemplate'],
    () =>
      fastify.prisma.workflowTemplate.findMany({
        include: { team: { select: { id: true, name: true, slug: true } } },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
        where,
      })
  );
  return rows.map((r) => ({
    activeVersion: r.activeVersion,
    description: r.description,
    id: r.id,
    isDefault: r.isDefault,
    name: r.name,
    team: r.team ? { id: r.team.id, name: r.team.name, slug: r.team.slug } : null,
  }));
}

export async function findTemplateByName(
  fastify: FastifyInstance,
  user: { id: string; role: Role },
  name: string
): Promise<
  | (SimpleTemplateRow & {
      spec: unknown | null;
      activeVersionRow: { version: number } | null;
    })
  | null
> {
  const tpls = await listVisibleTemplates(fastify, user);
  const tpl = tpls.find((t) => t.name === name);
  if (!tpl) {
    return null;
  }
  const v = tpl.activeVersion
    ? await fastify.prisma.workflowTemplateVersion.findUnique({
        where: { templateId_version: { templateId: tpl.id, version: tpl.activeVersion } },
      })
    : null;
  return {
    ...tpl,
    activeVersionRow: v ? { version: v.version } : null,
    spec: v ? v.spec : null,
  };
}

export function formatTemplateList(rows: SimpleTemplateRow[]): string {
  if (rows.length === 0) {
    return 'No workflow templates visible to you.';
  }
  const lines = rows.map((r) => {
    const teamLabel = r.team ? r.team.slug : 'global';
    const defaultLabel = r.isDefault ? ' *(default)*' : '';
    const versionLabel = r.activeVersion ? ` v${r.activeVersion}` : ' (no active version)';
    return `• \`${r.name}\` — ${teamLabel}${versionLabel}${defaultLabel}`;
  });
  return ['*Workflow templates*', ...lines].join('\n');
}

export function formatTemplateShow(
  tpl: SimpleTemplateRow & { spec: unknown | null; activeVersionRow: { version: number } | null }
): string {
  const teamLabel = tpl.team ? tpl.team.slug : 'global';
  const versionLabel = tpl.activeVersionRow
    ? `v${tpl.activeVersionRow.version}`
    : 'no active version';
  const header = `*${tpl.name}* — ${teamLabel} (${versionLabel})${tpl.isDefault ? ' — default' : ''}`;
  const desc = tpl.description ? `\n${tpl.description}` : '';
  if (!tpl.spec) {
    return `${header}${desc}`;
  }
  // Truncate to fit within Slack's 3000-char text limit for an ephemeral message.
  const json = JSON.stringify(tpl.spec, null, 2);
  const max = 2600;
  const trimmed = json.length > max ? `${json.slice(0, max)}\n…[truncated]` : json;
  return `${header}${desc}\n\`\`\`${trimmed}\`\`\``;
}
