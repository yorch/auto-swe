import { promises as fs } from 'node:fs';
import type {
  WorkflowTemplateDetail,
  WorkflowTemplateSummary,
  WorkflowTemplateVersionDetail,
} from '@auto-swe/shared/types/api';
import { apiRequest, GatewayError } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';

const SUB_HELP = `auto-swe workflows — manage workflow templates

  workflows list                         List visible templates
  workflows show <name> [--version=N]    Print the active (or specified) version spec
  workflows export <name> [-o <path>]    Write the active spec to a file (or stdout)
  workflows import <path> [--name=NAME] [--team=<slug>]
                                         Create a template (or add a new version if the name already exists)
`;

export async function runWorkflowsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  try {
    if (sub === 'list') return await cmdList(env);
    if (sub === 'show') return await cmdShow(rest, env);
    if (sub === 'export') return await cmdExport(rest, env);
    if (sub === 'import') return await cmdImport(rest, env);
  } catch (err) {
    if (err instanceof GatewayError) {
      process.stderr.write(`${err.code}: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  process.stderr.write(`Unknown subcommand: workflows ${sub}\n${SUB_HELP}`);
  return 1;
}

async function cmdList(env: CliEnv): Promise<number> {
  const rows = await apiRequest<WorkflowTemplateSummary[]>(
    env,
    'GET',
    '/api/v1/workflow-templates'
  );
  if (rows.length === 0) {
    process.stdout.write('No templates visible.\n');
    return 0;
  }
  const header = `${pad('NAME', 32) + pad('TEAM', 16) + pad('VERSION', 9) + pad('DEFAULT', 9)}STATUS\n`;
  process.stdout.write(header);
  for (const r of rows) {
    const team = r.team?.slug ?? 'global';
    const ver = r.activeVersion ? `v${r.activeVersion}` : '-';
    process.stdout.write(
      pad(r.name, 32) +
        pad(team, 16) +
        pad(ver, 9) +
        pad(r.isDefault ? 'yes' : '', 9) +
        `${r.status}\n`
    );
  }
  return 0;
}

async function cmdShow(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const name = positional[0];
  if (!name) {
    process.stderr.write('Usage: workflows show <name> [--version=N]\n');
    return 1;
  }
  const explicit = flags.version ? Number.parseInt(flags.version, 10) : undefined;
  const { spec } = await fetchSpec(env, name, explicit);
  process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
  return 0;
}

async function cmdExport(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const name = positional[0];
  if (!name) {
    process.stderr.write('Usage: workflows export <name> [-o <path>]\n');
    return 1;
  }
  const explicit = flags.version ? Number.parseInt(flags.version, 10) : undefined;
  const { spec, template, version } = await fetchSpec(env, name, explicit);
  const output = flags.o ?? flags.output;
  const payload = `${JSON.stringify(spec, null, 2)}\n`;
  if (output) {
    await fs.writeFile(output, payload);
    process.stderr.write(`Wrote ${template.name} v${version} → ${output}\n`);
  } else {
    process.stdout.write(payload);
  }
  return 0;
}

async function cmdImport(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const path = positional[0];
  if (!path) {
    process.stderr.write('Usage: workflows import <path> [--name=NAME] [--team=<slug>]\n');
    return 1;
  }
  const raw = await fs.readFile(path, 'utf8');
  let spec: unknown;
  try {
    spec = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `${path}: invalid JSON — ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }

  const name = flags.name ?? deriveNameFromPath(path);
  const existing = await findTemplateByName(env, name);

  if (existing) {
    // Subsequent import → new version on the existing template.
    const created = await apiRequest<WorkflowTemplateVersionDetail>(
      env,
      'POST',
      `/api/v1/workflow-templates/${existing.id}/versions`,
      { spec }
    );
    process.stdout.write(`Created version v${created.version} on "${existing.name}"\n`);
    return 0;
  }

  let teamId: string | null = null;
  if (flags.team) {
    teamId = await resolveTeamIdBySlug(env, flags.team);
    if (!teamId) {
      process.stderr.write(`No team with slug "${flags.team}"\n`);
      return 1;
    }
  }
  const created = await apiRequest<WorkflowTemplateSummary>(
    env,
    'POST',
    '/api/v1/workflow-templates',
    {
      name,
      spec,
      teamId,
    }
  );
  process.stdout.write(
    `Created "${created.name}" v${created.activeVersion ?? 1}${created.team ? ` in team ${created.team.slug}` : ' (global)'}\n`
  );
  return 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function fetchSpec(
  env: CliEnv,
  name: string,
  version: number | undefined
): Promise<{ spec: unknown; template: WorkflowTemplateSummary; version: number }> {
  const tpl = await findTemplateByName(env, name);
  if (!tpl) throw new Error(`No template named "${name}" is visible.`);
  const requested = version ?? tpl.activeVersion;
  if (!requested) {
    throw new Error(`Template "${name}" has no active version. Pass --version=N to pick one.`);
  }
  if (version !== undefined) {
    const detail = await apiRequest<WorkflowTemplateVersionDetail>(
      env,
      'GET',
      `/api/v1/workflow-templates/${tpl.id}/versions/${version}`
    );
    return { spec: detail.spec, template: tpl, version: detail.version };
  }
  const detail = await apiRequest<WorkflowTemplateDetail>(
    env,
    'GET',
    `/api/v1/workflow-templates/${tpl.id}`
  );
  if (!detail.activeVersionSpec) {
    throw new Error(`Template "${name}" has no active version spec.`);
  }
  return {
    spec: detail.activeVersionSpec.spec,
    template: tpl,
    version: detail.activeVersionSpec.version,
  };
}

async function findTemplateByName(
  env: CliEnv,
  name: string
): Promise<WorkflowTemplateSummary | null> {
  const rows = await apiRequest<WorkflowTemplateSummary[]>(
    env,
    'GET',
    '/api/v1/workflow-templates'
  );
  return rows.find((r) => r.name === name) ?? null;
}

async function resolveTeamIdBySlug(env: CliEnv, slug: string): Promise<string | null> {
  const teams = await apiRequest<Array<{ id: string; slug: string }>>(env, 'GET', '/api/v1/teams');
  return teams.find((t) => t.slug === slug)?.id ?? null;
}

function deriveNameFromPath(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.json$/i, '').replace(/[^a-zA-Z0-9_\- ]/g, '-');
}

function pad(s: string, w: number): string {
  if (s.length >= w) return `${s.slice(0, w - 1)} `;
  return s + ' '.repeat(w - s.length);
}

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string>;
}

export function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = 'true';
        }
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[a.slice(1)] = next;
        i++;
      } else {
        flags[a.slice(1)] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}
