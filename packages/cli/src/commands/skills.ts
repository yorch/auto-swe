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
  skills sources check <id>               Ask the host now whether the source's ref moved
  skills sources diff <id> [--sha=<commit>] [--skill=<name> --full]
                                           Show what the newer commit changes, per skill (writes nothing);
                                           --skill --full prints one skill's complete incoming text
  skills sources accept <id> [--skills=a,b] [--yes]
                                           Review the diff, then cut new revisions from the latest commit

  A scheduled check flags a source when its ref moves (status UPDATE_AVAILABLE); it never
  changes a skill. accept updates the changed skills that you have not edited by hand;
  a hand-edited skill is reported as a conflict and is overwritten only if --skills names it.
  Added skills are listed, never installed; removed skills are flagged, never deleted.
  Updated skills become a new revision and start unverified; running workflows keep theirs.

  Imported skills start unverified. Wherever their text reaches a model it is labelled
  [external: owner/repo@sha7] (the skill menu, loadSkill, and every prompt the text is
  inlined into). The repository is read with the platform's GitHub credential when the
  host has one (the instance's own host, including github.com when that is the instance,
  and any approved host with its own credential) and anonymously otherwise; a preview or
  import spends at most 300 API requests and stops early if the host's rate limit runs low.
  --script-mode=text-only (default) keeps .md/.txt files beside a SKILL.md as
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
  ignoredKeys?: string[];
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
    if (sub === 'check') {
      return await cmdCheck(rest, env);
    }
    if (sub === 'diff') {
      return await cmdDiff(rest, env);
    }
    if (sub === 'accept') {
      return await cmdAccept(rest, env, confirm);
    }
    return UNKNOWN_SUBCOMMAND;
  });
  if (handled !== UNKNOWN_SUBCOMMAND) {
    return handled;
  }
  process.stderr.write(`Unknown subcommand: skills sources ${sub ?? ''}\n${SUB_HELP}`);
  return 1;
}

// Everything below that came from the server describes a third-party repository: its
// names can carry terminal escapes, so control characters never reach the terminal.
// An emoji renders as one: a variation selector after a pictograph (not (c), (r), TM), a keycap's
// selector and a joiner between two pictographs are left alone; the rest is replaced or shown.
const CONTROL =
  /(?!(?:(?<=[0-9#*])\uFE0F(?=\u20E3)|(?<=[\p{Emoji_Presentation}\p{Extended_Pictographic}])(?<![\u00A9\u00AE\u2122])[\uFE0E\uFE0F]))(?!(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?)\u200D(?=\p{Extended_Pictographic}))[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
const clean = (s: string) => s.replace(CONTROL, '?');

const short = (sha: string) => clean(sha).slice(0, 7);
const where = (s: { host: string; owner: string; repo: string; path: string }) =>
  clean(
    `${s.host === 'github.com' ? '' : `${s.host}/`}${s.owner}/${s.repo}${s.path ? `/${s.path}` : ''}`
  );

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
        pad(clean(r.id), 38) +
        pad(where(r), 40) +
        pad(clean(r.ref), 14) +
        pad(short(r.pinnedSha), 9) +
        pad(clean(r.status), 18) +
        pad(clean(r.scriptMode), 11)
      }${r.skillCount}\n`
    );
    if (r.lastError) {
      process.stdout.write(`    last error: ${clean(r.lastError)}\n`);
    }
  }
  return 0;
}

function describe(s: PreviewSkill): string {
  const notes: string[] = [];
  notes.push(...s.errors.map((e) => `error: ${clean(e)}`));
  notes.push(...s.conflicts.map((c) => `name already used by a ${clean(c.scope)} skill`));
  notes.push(...s.scanWarnings.map((w) => `scan: ${clean(w)}`));
  if (s.blockedByScan) {
    notes.push('blocked: skills.import.blockOnScanWarnings is on');
  }
  if (s.skippedFiles.length > 0) {
    notes.push(
      `skipped ${s.skippedFiles.length} file(s): ${s.skippedFiles.map((f) => clean(f.path)).join(', ')}`
    );
  }
  if (s.ignoredKeys?.length) {
    notes.push(`ignored frontmatter: ${s.ignoredKeys.map(clean).join(', ')}`);
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
      `  ${s.installable ? '+' : '-'} ${clean(s.name ?? s.folder)}  (${s.textLength} chars, ${s.referenceFileCount} reference file(s))\n${describe(s)}`
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
      `Import ${names.length} skill(s) (${names.map(clean).join(', ')}) at ${short(preview.sha)}?`
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
    `Imported ${created.skills.length} skill(s) from ${where(preview.location)}@${short(preview.sha)} as source ${clean(created.source.id)}. They are unverified.\n`
  );
  return 0;
}

// ── tracked updates ─────────────────────────────────────────────────────────

interface SourceStatus {
  id: string;
  pinnedSha: string;
  latestSha: string | null;
  status: string;
  lastError: string | null;
}

interface ChangedSkill {
  name: string;
  handEdited: boolean;
  installedRevision: number;
  description: { changed: boolean; old: string | null; new: string | null };
  textDiff: string;
  textDiffTruncated: boolean;
  diffTooLarge: boolean;
  diffIncomplete: boolean;
  renamedTo: string | null;
  referenceFiles: { added: string[]; changed: string[]; removed: string[] };
  scanWarnings: string[];
  blockedByScan: boolean;
  skippedFiles: Array<{ path: string; reason: string }>;
}

interface DiffResult {
  sha: string;
  source: SourceStatus;
  unchanged: Array<{ name: string; handEdited: boolean }>;
  changed: ChangedSkill[];
  added: Array<{ folder: string; name: string | null; errors: string[]; scanWarnings: string[] }>;
  removed: Array<{ name: string; folder: string }>;
  errors: Array<{ name: string; errors: string[] }>;
}

interface IncomingSkill {
  name: string | null;
  sha: string;
  description: string | null;
  promptText: string;
  errors: string[];
}

interface CheckResult {
  recorded: boolean;
  check: { status: string; error: string | null };
  source: SourceStatus;
}

interface AcceptResult {
  renamed: Array<{ name: string; renamedTo: string }>;
  sha: string;
  accepted: Array<{ name: string; fromRevision: number; revision: number }>;
  conflicts: string[];
  notSelected: string[];
  unreadable: string[];
  removed: string[];
  added: string[];
  pinAdvanced: boolean;
  after: { pinnedSha: string; status: string };
}

const SOURCES_URL = '/api/v1/platform/skill-sources';

function idArg(
  args: string[],
  usage: string
): { id: string; flags: Record<string, string> } | null {
  const { positional, flags } = parseFlags(args);
  const [id] = positional;
  if (!id || positional.length > 1) {
    process.stderr.write(usage);
    return null;
  }
  return { flags, id };
}

async function cmdCheck(args: string[], env: CliEnv): Promise<number> {
  const parsed = idArg(args, 'Usage: skills sources check <id>\n');
  if (!parsed) {
    return 1;
  }
  const {
    check,
    recorded,
    source: row,
  } = await apiRequest<CheckResult>(
    env,
    'POST',
    `${SOURCES_URL}/${encodeURIComponent(parsed.id)}/check`
  );
  if (!recorded) {
    process.stdout.write(
      `${clean(row.id)}: not recorded: the source changed while it was being checked (disabled, or a newer commit accepted). Check again.\n`
    );
    return 0;
  }
  if (check.status === 'SKIPPED') {
    process.stdout.write(
      `${clean(row.id)}: skipped: ${clean(check.error ?? 'rate limited')}; its status is unchanged (${clean(row.status)}).\n`
    );
    return 0;
  }
  process.stdout.write(
    `${clean(row.id)}: ${clean(row.status)} (pinned ${short(row.pinnedSha)}, latest ${row.latestSha ? short(row.latestSha) : 'unknown'})\n`
  );
  if (row.lastError) {
    process.stdout.write(`  last error: ${clean(row.lastError)}\n`);
  }
  return 0;
}

/** A unified diff as text for a terminal: each line cleaned on its own so line breaks survive. */
const INVISIBLE =
  /(?!(?:(?<=[0-9#*])\uFE0F(?=\u20E3)|(?<=[\p{Emoji_Presentation}\p{Extended_Pictographic}])(?<![\u00A9\u00AE\u2122])[\uFE0E\uFE0F]))(?!(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?\uFE0F?)\u200D(?=\p{Extended_Pictographic}))[\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/gu;
/** Bidi overrides and zero-width characters in review text are shown, not hidden or dropped. */
const visible = (l: string) =>
  l.replace(
    INVISIBLE,
    (c) => `<U+${(c.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}>`
  );
const diffBody = (text: string) =>
  text
    .split('\n')
    .map((l) => `      ${clean(visible(l))}`)
    .join('\n');

function printDiff(d: DiffResult): void {
  const out = process.stdout;
  out.write(
    `${clean(d.source.id)}: pinned ${short(d.source.pinnedSha)} → ${short(d.sha)}: ${d.changed.length} changed, ${d.unchanged.length} unchanged, ${d.added.length} not installed, ${d.removed.length} removed\n`
  );
  for (const c of d.changed) {
    out.write(`  ~ ${clean(c.name)}  (installed revision ${c.installedRevision})\n`);
    if (c.renamedTo) {
      out.write(
        `      upstream now names it ${clean(visible(c.renamedTo))}; accepting keeps the installed name\n`
      );
    }
    if (c.handEdited) {
      out.write(
        '      conflict: edited by hand since it was imported; accepting overwrites those edits (name it in --skills)\n'
      );
    }
    if (c.description.changed) {
      out.write(
        `      description: ${clean(visible(c.description.old ?? ''))} → ${clean(visible(c.description.new ?? ''))}\n`
      );
    }
    const refs = c.referenceFiles;
    for (const [label, paths] of [
      ['reference files added', refs.added],
      ['reference files changed', refs.changed],
      ['reference files removed', refs.removed],
    ] as const) {
      if (paths.length > 0) {
        out.write(`      ${label}: ${paths.map(clean).join(', ')}\n`);
      }
    }
    for (const w of c.scanWarnings) {
      out.write(`      scan: ${clean(w)}\n`);
    }
    if (c.blockedByScan) {
      out.write('      blocked: skills.import.blockOnScanWarnings is on\n');
    }
    if (c.skippedFiles.length > 0) {
      out.write(`      skipped ${c.skippedFiles.length} file(s)\n`);
    }
    if (c.textDiff) {
      out.write(`${diffBody(c.textDiff)}\n`);
    }
    if (c.diffIncomplete) {
      out.write(
        `      ${c.diffTooLarge ? 'diff too large to show' : 'diff truncated'}: read the complete incoming text with: skills sources diff ${clean(d.source.id)} --skill=${clean(c.name)} --full\n`
      );
    }
  }
  for (const a of d.added) {
    out.write(
      `  + ${clean(a.name ?? a.folder)}  not installed (accept does not install it)${a.errors.length ? `; error: ${a.errors.map(clean).join('; ')}` : ''}\n`
    );
  }
  for (const r of d.removed) {
    out.write(`  - ${clean(r.name)}  no longer in the source; left installed\n`);
  }
  for (const e of d.errors) {
    out.write(`  ! ${clean(e.name)}  cannot be updated: ${e.errors.map(clean).join('; ')}\n`);
  }
}

async function cmdDiff(args: string[], env: CliEnv): Promise<number> {
  const usage = 'Usage: skills sources diff <id> [--sha=<commit>] [--skill=<name> --full]\n';
  const parsed = idArg(args, usage);
  if (!parsed) {
    return 1;
  }
  const bad = missingValue(parsed.flags, 'sha', 'skill');
  const full = parsed.flags.full === FLAG_PRESENT || parsed.flags.full === 'true';
  if (bad || (full && !parsed.flags.skill)) {
    process.stderr.write(
      bad ? `--${bad} requires a value\n${usage}` : `--full needs --skill\n${usage}`
    );
    return 1;
  }
  const params = new URLSearchParams();
  if (parsed.flags.sha) {
    params.set('sha', parsed.flags.sha);
  }
  if (full && parsed.flags.skill) {
    params.set('skill', parsed.flags.skill);
    params.set('full', 'true');
  }
  const query = params.size > 0 ? `?${params}` : '';
  const url = `${SOURCES_URL}/${encodeURIComponent(parsed.id)}/diff${query}`;
  if (full) {
    const skill = await apiRequest<IncomingSkill>(env, 'GET', url);
    process.stdout.write(
      `${clean(skill.name ?? '')} at ${short(skill.sha)}: ${skill.promptText.length} characters\ndescription: ${clean(visible(skill.description ?? ''))}\n${diffBody(skill.promptText)}\n`
    );
    for (const e of skill.errors) {
      process.stdout.write(`error: ${clean(e)}\n`);
    }
    return 0;
  }
  printDiff(await apiRequest<DiffResult>(env, 'GET', url));
  return 0;
}

async function cmdAccept(args: string[], env: CliEnv, confirm: Confirm): Promise<number> {
  const usage = 'Usage: skills sources accept <id> [--skills=a,b] [--yes]\n';
  const parsed = idArg(args, usage);
  if (!parsed) {
    return 1;
  }
  const bad = missingValue(parsed.flags, 'skills');
  if (bad) {
    process.stderr.write(`--${bad} requires a value\n${usage}`);
    return 1;
  }
  const id = encodeURIComponent(parsed.id);
  const diff = await apiRequest<DiffResult>(env, 'GET', `${SOURCES_URL}/${id}/diff`);
  printDiff(diff);

  const named = parsed.flags.skills ? parsed.flags.skills.split(',').map((n) => n.trim()) : null;
  const notChanged = named?.filter((n) => !diff.changed.some((c) => c.name === n)) ?? [];
  if (notChanged.length > 0) {
    process.stderr.write(
      `Not changed upstream, or not installed from this source: ${notChanged.map(clean).join(', ')}\n`
    );
    return 1;
  }
  const willUpdate = diff.changed.filter((c) => (named ? named.includes(c.name) : !c.handEdited));
  const unread = named ? [] : willUpdate.filter((c) => c.diffIncomplete);
  if (unread.length > 0) {
    process.stderr.write(
      `The diff of ${unread.map((c) => clean(c.name)).join(', ')} was cut or too large. Read the full text (skills sources diff ${clean(parsed.id)} --skill=<name> --full), then name the skills in --skills to accept them.\n`
    );
    return 1;
  }
  const conflicts = diff.changed.filter((c) => c.handEdited && !willUpdate.includes(c));
  if (conflicts.length > 0) {
    process.stderr.write(
      `Left alone (edited by hand): ${conflicts.map((c) => clean(c.name)).join(', ')}. Name them in --skills to overwrite.\n`
    );
  }
  if (willUpdate.length === 0 && diff.changed.length > 0) {
    process.stderr.write('Nothing to update.\n');
    return 1;
  }
  const yes = parsed.flags.yes === FLAG_PRESENT || parsed.flags.yes === 'true';
  const names = willUpdate.map((c) => clean(c.name));
  if (
    !yes &&
    !(await confirm(
      `Update ${names.length} skill(s) (${names.join(', ') || 'none'}) to ${short(diff.sha)}? They become new unverified revisions.`
    ))
  ) {
    process.stderr.write('Aborted; nothing was changed (pass --yes to skip the prompt).\n');
    return 1;
  }

  const result = await apiRequest<AcceptResult>(env, 'POST', `${SOURCES_URL}/${id}/accept`, {
    sha: diff.sha,
    // Each named skill is bound to the installed revision the diff above showed.
    ...(named
      ? {
          skills: willUpdate.map((c) => ({ name: c.name, revision: c.installedRevision })),
        }
      : {}),
  });
  for (const a of result.accepted) {
    process.stdout.write(
      `Updated ${clean(a.name)}: revision ${a.fromRevision} → ${a.revision} (unverified)\n`
    );
  }
  if (result.conflicts.length > 0) {
    process.stdout.write(
      `Left alone (edited by hand): ${result.conflicts.map(clean).join(', ')}\n`
    );
  }
  if (result.notSelected.length > 0) {
    process.stdout.write(`Not selected: ${result.notSelected.map(clean).join(', ')}\n`);
  }
  for (const r of result.renamed) {
    process.stdout.write(
      `Upstream now names ${clean(r.name)} as ${clean(visible(r.renamedTo))}; the installed name is kept.\n`
    );
  }
  process.stdout.write(
    result.pinAdvanced
      ? `Source pinned at ${short(result.sha)}.\n`
      : `Source stays at ${short(result.after.pinnedSha)} (UPDATE_AVAILABLE): some changed skills were not updated.\n`
  );
  return 0;
}
