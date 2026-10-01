import { promises as fs } from 'node:fs';
import type {
  WorkflowTemplateDetail,
  WorkflowTemplateSummary,
  WorkflowTemplateVersionDetail,
} from '@auto-swe/shared/types/api';
import { apiRequest, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { missingValue, parseFlags } from '../lib/flags.js';
import { pad, parseOptionalPositiveInt } from '../lib/format.js';
import { sleep } from '../lib/time.js';

const SUB_HELP = `auto-swe workflows — manage workflow templates

  workflows list                         List visible templates
  workflows show <name> [--version=N]    Print the active (or specified) version spec
  workflows export <name> [-o <path>]    Write the active spec to a file (or stdout)
  workflows import <path> [--name=NAME] [--team=<slug>]
                                         Create a template (or add a new version if the name already exists)
  workflows run <name> --payload=<json> [--label=<text>]
                                         Start a run with a generic JSON payload
  workflows generate "<description>" [--name=NAME] [--team=<slug>]
                                         Generate a DRAFT template from a plain-language description (AI)
  workflows explain <name>               Explain a template's active version in plain language (AI)

  Template names are unique per team, not globally. show, export, import, run
  and explain take --team=<slug> (or --global for a team-less template) to pick
  one; a name that matches templates in more than one scope is an error until
  you do.
`;

export async function runWorkflowsCommand(args: string[], env: CliEnv): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'list') {
      return await cmdList(env);
    }
    if (sub === 'show') {
      return await cmdShow(rest, env);
    }
    if (sub === 'export') {
      return await cmdExport(rest, env);
    }
    if (sub === 'import') {
      return await cmdImport(rest, env);
    }
    if (sub === 'generate') {
      return await cmdGenerate(rest, env);
    }
    if (sub === 'explain') {
      return await cmdExplain(rest, env);
    }
    if (sub === 'run') {
      return await cmdRun(rest, env);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
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
    process.stderr.write('Usage: workflows show <name> [--version=N] [--team=<slug>|--global]\n');
    return 1;
  }
  const explicit = parseVersionFlag(flags.version);
  if (explicit === 'invalid') {
    process.stderr.write('--version must be a positive integer\n');
    return 1;
  }
  const scope = parseScope(flags);
  if (typeof scope === 'string') {
    process.stderr.write(`${scope}\n`);
    return 1;
  }
  const { spec } = await fetchSpec(env, name, explicit, scope);
  process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
  return 0;
}

async function cmdExport(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const name = positional[0];
  if (!name) {
    process.stderr.write(
      'Usage: workflows export <name> [-o <path>] [--version=N] [--team=<slug>|--global]\n'
    );
    return 1;
  }
  const explicit = parseVersionFlag(flags.version);
  if (explicit === 'invalid') {
    process.stderr.write('--version must be a positive integer\n');
    return 1;
  }
  // parseFlags assigns the sentinel 'true' to a flag declared without a value
  // (e.g. `-o` with nothing after it). Reject that explicitly so we don't
  // create a file literally named `true`.
  const rawOutput = flags.o ?? flags.output;
  if (rawOutput === 'true') {
    process.stderr.write('-o/--output requires a file path\n');
    return 1;
  }
  const output = rawOutput;
  const scope = parseScope(flags);
  if (typeof scope === 'string') {
    process.stderr.write(`${scope}\n`);
    return 1;
  }
  const { spec, template, version } = await fetchSpec(env, name, explicit, scope);
  const payload = `${JSON.stringify(spec, null, 2)}\n`;
  if (output) {
    await fs.writeFile(output, payload);
    process.stderr.write(`Wrote ${template.name} v${version} → ${output}\n`);
  } else {
    process.stdout.write(payload);
  }
  return 0;
}

const parseVersionFlag = parseOptionalPositiveInt;

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

  const bare = missingValue(flags, 'name', 'team');
  if (bare) {
    process.stderr.write(`--${bare} requires a value\n`);
    return 1;
  }
  const scope = parseScope(flags);
  if (typeof scope === 'string') {
    process.stderr.write(`${scope}\n`);
    return 1;
  }
  const name = flags.name ?? deriveNameFromPath(path);
  // Scoped by --team / --global, so a same-named template in another team is
  // never versioned by mistake; unscoped, an ambiguous name is an error.
  const existing = await findTemplateByName(env, name, scope);

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

type GenerationJobStatus =
  | { status: 'running'; phase?: string }
  | { status: 'done'; templateId: string; name: string; summary: string; attempts: number }
  | { status: 'failed'; code: string; message: string };

/** Poll cadence and ceiling for a generation job. The job's generate activity
 * is bounded at 5 minutes and its persist step at 30 s, so the ceiling only
 * trips when the job itself is stuck. */
export const GENERATE_POLL_MS = 2_000;
export const GENERATE_DEADLINE_MS = 10 * 60 * 1000;

async function cmdGenerate(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const prompt = positional.join(' ').trim();
  if (!prompt) {
    process.stderr.write(
      'Usage: workflows generate "<description>" [--name=NAME] [--team=<slug>]\n'
    );
    return 1;
  }

  const bare = missingValue(flags, 'name', 'team');
  if (bare) {
    process.stderr.write(`--${bare} requires a value\n`);
    return 1;
  }
  let teamId: string | null = null;
  if (flags.team) {
    teamId = await resolveTeamIdBySlug(env, flags.team);
    if (!teamId) {
      process.stderr.write(`No team with slug "${flags.team}"\n`);
      return 1;
    }
  }

  // The asynchronous job endpoint, polled to completion: a generation can take
  // minutes, longer than a proxy in front of the gateway will hold a request
  // open. (The job path does not author shell nodes; the canvas's synchronous
  // generator is the shell-capable one.)
  const { jobId } = await apiRequest<{ jobId: string }>(
    env,
    'POST',
    '/api/v1/workflow-templates/generate/jobs',
    { name: flags.name, prompt, teamId }
  );
  process.stderr.write(`Generating workflow from your description (job ${jobId})…\n`);

  const deadline = Date.now() + GENERATE_DEADLINE_MS;
  let res: GenerationJobStatus;
  for (;;) {
    res = await apiRequest<GenerationJobStatus>(
      env,
      'GET',
      `/api/v1/workflow-templates/generate/jobs/${encodeURIComponent(jobId)}`
    );
    if (res.status !== 'running') {
      break;
    }
    if (Date.now() > deadline) {
      process.stderr.write(`Timed out waiting for generation job ${jobId}\n`);
      return 2;
    }
    await sleep(GENERATE_POLL_MS);
  }
  if (res.status === 'failed') {
    process.stderr.write(`${res.code}: ${res.message}\n`);
    return 2;
  }

  process.stdout.write(
    `Created DRAFT "${res.name}" (id ${res.templateId})${flags.team ? ` in team ${flags.team}` : ' (global)'}\n`
  );
  if (res.summary) {
    process.stdout.write(`Summary: ${res.summary}\n`);
  }
  if (res.attempts > 1) {
    process.stdout.write(`(took ${res.attempts} attempts to produce a valid spec)\n`);
  }
  const scopeFlag = flags.team ? ` --team=${flags.team}` : ' --global';
  process.stdout.write(
    `Review and activate it on the canvas, or run: auto-swe workflows show "${res.name}"${scopeFlag}\n`
  );
  return 0;
}

async function cmdExplain(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const name = positional[0];
  if (!name) {
    process.stderr.write('Usage: workflows explain <name> [--team=<slug>|--global]\n');
    return 1;
  }
  const scope = parseScope(flags);
  if (typeof scope === 'string') {
    process.stderr.write(`${scope}\n`);
    return 1;
  }
  const tpl = await findTemplateByName(env, name, scope);
  if (!tpl) {
    process.stderr.write(`No template named "${name}" is visible.\n`);
    return 1;
  }
  process.stderr.write('Explaining workflow…\n');
  const { explanation } = await apiRequest<{ explanation: string }>(
    env,
    'POST',
    `/api/v1/workflow-templates/${tpl.id}/explain`
  );
  process.stdout.write(`${explanation}\n`);
  return 0;
}

async function cmdRun(args: string[], env: CliEnv): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const name = positional[0];
  if (!name) {
    process.stderr.write(
      'Usage: workflows run <name> --payload=<json> [--label=<text>] [--team=<slug>|--global]\n'
    );
    return 1;
  }
  const scope = parseScope(flags);
  if (typeof scope === 'string') {
    process.stderr.write(`${scope}\n`);
    return 1;
  }
  const tpl = await findTemplateByName(env, name, scope);
  if (!tpl) {
    process.stderr.write(`No template named "${name}" is visible.\n`);
    return 1;
  }

  let payload: Record<string, unknown> = {};
  if (flags.payload && flags.payload !== 'true') {
    try {
      payload = JSON.parse(flags.payload) as Record<string, unknown>;
    } catch (err) {
      process.stderr.write(
        `--payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`
      );
      return 1;
    }
  }

  const body: { label?: string; payload: Record<string, unknown> } = { payload };
  if (flags.label && flags.label !== 'true') {
    body.label = flags.label;
  }

  const res = await apiRequest<{
    temporalWorkflowId: string;
    workflowId: string;
    workRequestId: string;
  }>(env, 'POST', `/api/v1/workflow-templates/${tpl.id}/runs`, body);

  process.stdout.write(
    `Started run for "${name}": workRequestId=${res.workRequestId} workflowId=${res.workflowId} temporalWorkflowId=${res.temporalWorkflowId}\n`
  );
  return 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function fetchSpec(
  env: CliEnv,
  name: string,
  version: number | undefined,
  scope: TemplateScope
): Promise<{ spec: unknown; template: WorkflowTemplateSummary; version: number }> {
  const tpl = await findTemplateByName(env, name, scope);
  if (!tpl) {
    throw new Error(`No template named "${name}" is visible.`);
  }
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

/**
 * Which templates a name lookup may match. Names are unique per team
 * (`(team_id, name)`), so the same name can exist once globally and once in
 * every team the caller sees.
 */
export type TemplateScope = { kind: 'any' } | { kind: 'global' } | { kind: 'team'; slug: string };

/** `--team=<slug>` / `--global` → a scope, or a usage error string. */
function parseScope(flags: Record<string, string>): TemplateScope | string {
  const bare = missingValue(flags, 'team');
  if (bare) {
    return `--${bare} requires a value`;
  }
  if (flags.team && flags.global) {
    return '--team and --global are mutually exclusive';
  }
  if (flags.team) {
    return { kind: 'team', slug: flags.team };
  }
  if (flags.global) {
    return { kind: 'global' };
  }
  return { kind: 'any' };
}

function scopeLabel(r: WorkflowTemplateSummary): string {
  return r.team?.slug ? `team ${r.team.slug}` : 'global';
}

/**
 * The one visible template called `name` within `scope`, or null when there is
 * none. Throws when more than one matches — silently taking the first would
 * act on another team's template.
 */
export async function findTemplateByName(
  env: CliEnv,
  name: string,
  scope: TemplateScope = { kind: 'any' }
): Promise<WorkflowTemplateSummary | null> {
  const rows = await apiRequest<WorkflowTemplateSummary[]>(
    env,
    'GET',
    '/api/v1/workflow-templates'
  );
  const matches = rows.filter((r) => {
    if (r.name !== name) {
      return false;
    }
    if (scope.kind === 'global') {
      return !r.team;
    }
    if (scope.kind === 'team') {
      return r.team?.slug === scope.slug;
    }
    return true;
  });
  if (matches.length > 1) {
    const where = matches.map(scopeLabel).join(', ');
    throw new Error(
      `Template name "${name}" matches ${matches.length} templates (${where}); pass --team=<slug> or --global to pick one.`
    );
  }
  return matches[0] ?? null;
}

async function resolveTeamIdBySlug(env: CliEnv, slug: string): Promise<string | null> {
  const teams = await apiRequest<Array<{ id: string; slug: string }>>(env, 'GET', '/api/v1/teams');
  return teams.find((t) => t.slug === slug)?.id ?? null;
}

function deriveNameFromPath(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.json$/i, '').replace(/[^a-zA-Z0-9_\- ]/g, '-');
}
