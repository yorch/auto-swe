import { createInterface } from 'node:readline/promises';
import { apiRequest, runWithExitCodes, UNKNOWN_SUBCOMMAND } from '../lib/api.js';
import type { CliEnv } from '../lib/env.js';
import { FLAG_PRESENT, missingValue, parseFlags } from '../lib/flags.js';
import { pad } from '../lib/format.js';

/**
 * `auto-swe skills sources` — import skills from an external GitHub / GitHub
 * Enterprise repository (admin token required). `add` is preview → confirm →
 * create: nothing is written until the preview has been shown and accepted, and
 * the create pins the commit the preview read.
 */
const SUB_HELP = `auto-swe skills — skill library (admin)

  skills sources list                     List tracked skill sources
  skills sources add <owner/repo> --ref=<branch|tag> [--host=github.com] [--path=<dir>]
                     [--script-mode=text-only|reject] [--skills=a,b] [--yes]
                                           Preview a repository's skills, then import them

  Imported skills start unverified and are labelled [external: owner/repo@sha] in the
  skill menu. --script-mode=text-only (default) keeps .md/.txt files beside a SKILL.md as
  reference text and skips every other file; reject refuses a skill folder holding any
  other file. Nothing is ever executed. Without --skills, every installable skill is
  imported; without --yes you are asked to confirm.
`;

interface PreviewSkill {
  folder: string;
  name: string | null;
  textLength: number;
  referenceFileCount: number;
  skippedFiles: Array<{ path: string; reason: string }>;
  scanWarnings: string[];
  conflicts: Array<{ name: string; scope: string }>;
  errors: string[];
  blockedByScan: boolean;
  installable: boolean;
}

interface Preview {
  sha: string;
  location: { host: string; owner: string; repo: string; path: string; ref: string };
  skills: PreviewSkill[];
}

interface SourceRow {
  id: string;
  host: string;
  owner: string;
  repo: string;
  path: string;
  ref: string;
  pinnedSha: string;
  status: string;
  scriptMode: string;
  scope: string;
  skillCount: number;
  lastError: string | null;
}

export type Confirm = (question: string) => Promise<boolean>;

const askYesNo: Confirm = async (question) => {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
};

export async function runSkillsCommand(
  args: string[],
  env: CliEnv,
  confirm: Confirm = askYesNo
): Promise<number> {
  const [group, sub, ...rest] = args;
  if (!group || group === 'help' || group === '-h' || group === '--help') {
    process.stdout.write(SUB_HELP);
    return 0;
  }
  if (group !== 'sources') {
    process.stderr.write(`Unknown subcommand: skills ${group}\n${SUB_HELP}`);
    return 1;
  }
  const handled = await runWithExitCodes(async () => {
    if (sub === 'list') {
      return await cmdList(env);
    }
    if (sub === 'add') {
      return await cmdAdd(rest, env, confirm);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: skills sources ${sub ?? ''}\n${SUB_HELP}`);
  return 1;
}

const short = (sha: string) => sha.slice(0, 7);
const where = (s: { host: string; owner: string; repo: string; path: string }) =>
  `${s.host === 'github.com' ? '' : `${s.host}/`}${s.owner}/${s.repo}${s.path ? `/${s.path}` : ''}`;

async function cmdList(env: CliEnv): Promise<number> {
  const rows = await apiRequest<SourceRow[]>(env, 'GET', '/api/v1/platform/skill-sources');
  if (rows.length === 0) {
    process.stdout.write('No skill sources.\n');
    return 0;
  }
  process.stdout.write(
    `${pad('ID', 38) + pad('SOURCE', 40) + pad('REF', 14) + pad('PINNED', 9) + pad('STATUS', 18) + pad('MODE', 11)}SKILLS\n`
  );
  for (const r of rows) {
    process.stdout.write(
      `${
        pad(r.id, 38) +
        pad(where(r), 40) +
        pad(r.ref, 14) +
        pad(short(r.pinnedSha), 9) +
        pad(r.status, 18) +
        pad(r.scriptMode, 11)
      }${r.skillCount}\n`
    );
    if (r.lastError) {
      process.stdout.write(`    last error: ${r.lastError}\n`);
    }
  }
  return 0;
}

function describe(s: PreviewSkill): string {
  const notes: string[] = [];
  notes.push(...s.errors.map((e) => `error: ${e}`));
  notes.push(...s.conflicts.map((c) => `name already used by a ${c.scope} skill`));
  notes.push(...s.scanWarnings.map((w) => `scan: ${w}`));
  if (s.blockedByScan) {
    notes.push('blocked: skills.import.blockOnScanWarnings is on');
  }
  if (s.skippedFiles.length > 0) {
    notes.push(
      `skipped ${s.skippedFiles.length} file(s): ${s.skippedFiles.map((f) => f.path).join(', ')}`
    );
  }
  return notes.map((n) => `      ${n}\n`).join('');
}

async function cmdAdd(args: string[], env: CliEnv, confirm: Confirm): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const usage =
    'Usage: skills sources add <owner/repo> --ref=<branch|tag> [--host=H] [--path=DIR] [--script-mode=text-only|reject] [--skills=a,b] [--yes]\n';
  const bad = missingValue(flags, 'ref', 'host', 'path', 'script-mode', 'skills');
  const [ownerRepo] = positional;
  const [owner, repo, ...extra] = (ownerRepo ?? '').split('/');
  if (bad || !owner || !repo || extra.length > 0 || !flags.ref) {
    process.stderr.write(bad ? `--${bad} requires a value\n${usage}` : usage);
    return 1;
  }
  const modeFlag = (flags['script-mode'] ?? 'text-only').toLowerCase();
  if (modeFlag !== 'text-only' && modeFlag !== 'reject') {
    process.stderr.write(`--script-mode must be text-only or reject\n${usage}`);
    return 1;
  }
  const source = {
    host: flags.host ?? 'github.com',
    owner,
    path: flags.path ?? '',
    ref: flags.ref,
    repo,
    scriptMode: modeFlag === 'reject' ? 'REJECT' : 'TEXT_ONLY',
  };

  const preview = await apiRequest<Preview>(
    env,
    'POST',
    '/api/v1/platform/skill-sources/preview',
    source
  );
  process.stdout.write(
    `${where(preview.location)}@${preview.location.ref} → ${short(preview.sha)}: ${preview.skills.length} skill(s)\n`
  );
  for (const s of preview.skills) {
    process.stdout.write(
      `  ${s.installable ? '+' : '-'} ${s.name ?? s.folder}  (${s.textLength} chars, ${s.referenceFileCount} reference file(s))\n${describe(s)}`
    );
  }

  const installable = preview.skills.filter((s) => s.installable && s.name !== null);
  const wanted = flags.skills ? flags.skills.split(',').map((n) => n.trim()) : null;
  const chosen = wanted
    ? installable.filter((s) => wanted.includes(s.name as string))
    : installable;
  const missing = wanted?.filter((n) => !chosen.some((s) => s.name === n)) ?? [];
  if (missing.length > 0) {
    process.stderr.write(`Not installable or not in the source: ${missing.join(', ')}\n`);
    return 1;
  }
  if (chosen.length === 0) {
    process.stderr.write('Nothing to install.\n');
    return 1;
  }
  const yes = flags.yes === FLAG_PRESENT || flags.yes === 'true';
  const names = chosen.map((s) => s.name as string);
  if (
    !yes &&
    !(await confirm(
      `Import ${names.length} skill(s) (${names.join(', ')}) at ${short(preview.sha)}?`
    ))
  ) {
    process.stderr.write('Aborted; nothing was imported (pass --yes to skip the prompt).\n');
    return 1;
  }

  const created = await apiRequest<{ skills: Array<{ name: string }>; source: { id: string } }>(
    env,
    'POST',
    '/api/v1/platform/skill-sources',
    { ...source, sha: preview.sha, skills: names }
  );
  process.stdout.write(
    `Imported ${created.skills.length} skill(s) from ${where(preview.location)}@${short(preview.sha)} as source ${created.source.id}. They are unverified.\n`
  );
  return 0;
}
