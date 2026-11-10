import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unsafeProfilePath } from '@auto-swe/shared/lib/harnessProfile';
import { ApplicationFailure } from '@temporalio/activity';
import type { Workspace } from '../../activities/workspace.js';
import type { ResolvedHarnessProfile } from '../../lib/config/harnessProfile.js';
import { shellQuote } from '../../lib/shellQuote.js';
import { workspaceBackend } from '../../lib/workspaceBackend/index.js';
import { HARNESS_DIR } from '../harness/adapter.js';

/** Where approved profiles are materialized in the container, outside the checkout. */
export const PROFILES_DIR = `${HARNESS_DIR}/profiles`;

const SCRIPT_TIMEOUT_MS = 60_000;

function integrity(profile: ResolvedHarnessProfile, why: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(
    `Harness profile '${profile.name}' version ${profile.version} cannot be put into the workspace: ${why}.`,
    'PROFILE_INTEGRITY'
  );
}

/** The first 12 hex digits of a profile's content hash: its directory name and its short identity. */
export function profileShortHash(profile: Pick<ResolvedHarnessProfile, 'contentHash'>): string {
  return profile.contentHash.slice(0, 12);
}

/** The commit a profile was approved at, shortened for traces. */
export function profileShortSha(profile: Pick<ResolvedHarnessProfile, 'commitSha'>): string {
  return profile.commitSha.slice(0, 12);
}

/** Where `profile` lives in the container. */
export function profileContainerDir(profile: Pick<ResolvedHarnessProfile, 'contentHash'>): string {
  return `${PROFILES_DIR}/${profileShortHash(profile)}`;
}

/** A manifest path in the spelling the snapshot stores it under; null when it is unsafe. */
function manifestRel(raw: string): string | null {
  const rel = raw.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  return unsafeProfilePath(rel) === null ? rel : null;
}

/** The plugin directories the SDK loads, as paths inside the container. */
export function profilePluginDirs(profile: ResolvedHarnessProfile): string[] {
  const dir = profileContainerDir(profile);
  return (profile.manifest.plugins ?? []).map((plugin) => {
    const rel = manifestRel(plugin);
    if (rel === null) {
      throw integrity(profile, 'a plugin path is not a safe relative path');
    }
    return `${dir}/${rel}`;
  });
}

/** Characters that render as nothing, so a line can look like it starts with a marker it does not. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}|\p{Cf}/gu;

/**
 * Whether any line of `text` opens with `[profile:`, however it is spelled:
 * after NFKC (full-width brackets and letters fold to ASCII), case-folding,
 * and dropping invisible characters, with every line terminator (CR, LF, CRLF,
 * VT, FF, NEL, LS, PS) counted as a break and leading white space ignored.
 */
function spellsProvenanceMarker(text: string): boolean {
  const folded = text.normalize('NFKC').replace(INVISIBLE, '').toLowerCase();
  return folded
    .split(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/)
    .some((line) => /^\s*\[\s*profile\s*:/.test(line));
}

/**
 * The profile's instructions behind a provenance line, ready to append to a
 * system prompt; '' when it has none. The text is approved but still data: it is
 * appended as written, never interpreted. A text that spells the provenance
 * marker itself is refused rather than edited, since it could pass off its own
 * words as the worker's line.
 */
export function profileInstructions(profile: ResolvedHarnessProfile): string {
  const named = profile.manifest.instructions;
  if (named === undefined) {
    return '';
  }
  const rel = manifestRel(named);
  const file = rel === null ? undefined : profile.files.find((f) => f.path === rel);
  if (!file) {
    throw integrity(profile, 'its instructions file is missing from the snapshot');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
  } catch {
    throw integrity(profile, 'its instructions are not valid UTF-8');
  }
  if (spellsProvenanceMarker(text)) {
    throw integrity(profile, 'its instructions contain the harness provenance marker');
  }
  const mark = `[profile: ${profile.name}@${profile.version} sha ${profileShortHash(profile)}]`;
  return `${mark}\n${text.trimEnd()}`;
}

/** `system` with the profile's instructions appended; `system` itself when there are none. */
export function withProfileInstructions(system: string, profile: ResolvedHarnessProfile): string {
  const instructions = profileInstructions(profile);
  return instructions ? `${system}\n\n${instructions}` : system;
}

const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Every directory a set of file paths needs, `.` included, as `find` prints them. */
function directoriesOf(paths: readonly string[]): string[] {
  const dirs = new Set(['.']);
  for (const p of paths) {
    const parts = p.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      dirs.add(`./${parts.slice(0, i).join('/')}`);
    }
  }
  return [...dirs].sort(byBytes);
}

const TAR_BLOCK = 512;

/** An octal field of `width` bytes: digits, then a NUL. */
function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

/** One ustar entry (header and padded data); `name` is split into name and prefix when long. */
function tarEntry(
  profile: ResolvedHarnessProfile,
  name: string,
  mode: number,
  data: Buffer | null
): Buffer {
  let base = Buffer.from(name);
  let prefix = Buffer.alloc(0);
  if (base.length > 100) {
    // A path that does not fit as one is split at a slash into a prefix and a name
    // (a directory keeps its trailing slash in the name).
    const trailing = name.endsWith('/') ? '/' : '';
    const core = trailing ? name.slice(0, -1) : name;
    const at = core.lastIndexOf('/');
    const left = Buffer.from(core.slice(0, at));
    const right = Buffer.from(core.slice(at + 1) + trailing);
    if (at <= 0 || left.length > 155 || right.length > 100 || right.length === trailing.length) {
      throw integrity(profile, 'a file path is too long to copy into the workspace');
    }
    prefix = left;
    base = right;
  }
  const header = Buffer.alloc(TAR_BLOCK);
  base.copy(header, 0);
  header.write(octal(mode, 8), 100, 'latin1');
  header.write(octal(0, 8), 108, 'latin1');
  header.write(octal(0, 8), 116, 'latin1');
  header.write(octal(data?.length ?? 0, 12), 124, 'latin1');
  header.write(octal(0, 12), 136, 'latin1');
  header.fill(0x20, 148, 156);
  header.write(data ? '0' : '5', 156, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  prefix.copy(header, 345);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  if (!data) {
    return header;
  }
  const padding = Buffer.alloc((TAR_BLOCK - (data.length % TAR_BLOCK)) % TAR_BLOCK);
  return Buffer.concat([header, data, padding]);
}

/**
 * The snapshot as one ustar archive, rooted at the profile directory: every
 * directory (mode 0755), then every file (0755 for an executable, 0644
 * otherwise), all owned by root and with no link, device or special entry. Each
 * path is checked again here, independent of the checks that ran when the
 * snapshot was unpacked. The container's daemon extracts it (`copyIn`); no
 * binary in the container reads or writes the archive.
 */
export function buildProfileTar(profile: ResolvedHarnessProfile): Buffer {
  const parts: Buffer[] = [];
  for (const file of profile.files) {
    if (unsafeProfilePath(file.path) !== null) {
      throw integrity(profile, 'a file path would leave the profile directory');
    }
  }
  for (const dir of directoriesOf(profile.files.map((f) => f.path))) {
    if (dir !== '.') {
      parts.push(tarEntry(profile, `${dir.slice(2)}/`, 0o755, null));
    }
  }
  const seen = new Set<string>();
  for (const file of [...profile.files].sort((a, b) => byBytes(a.path, b.path))) {
    if (seen.has(file.path)) {
      throw integrity(profile, 'a file path appears twice');
    }
    seen.add(file.path);
    parts.push(tarEntry(profile, file.path, file.mode === '100755' ? 0o755 : 0o644, file.bytes));
  }
  parts.push(Buffer.alloc(TAR_BLOCK * 2));
  return Buffer.concat(parts);
}

/** `name:` from a markdown file's front matter, or undefined. */
function frontMatterName(bytes: Buffer): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(bytes.toString('utf8'));
  const line = match?.[1]?.split(/\r?\n/).find((l) => /^name\s*:/.test(l));
  const value = line
    ?.replace(/^name\s*:\s*/, '')
    .trim()
    .replace(/^(["'])(.*)\1$/, '$2');
  return value || undefined;
}

/**
 * The skills and commands the profile's own plugins declare, in the spelling
 * the harness binary resolves a plugin's skill by: `<plugin>:<name>`. A skill
 * is `skills/<dir>/SKILL.md` (named by its directory or its `name:`); a command
 * is `commands/<path>.md` (a subdirectory becomes `<dir>:<name>`). The plugin's
 * name is its `plugin.json` name, else its directory's. A bare name is never
 * listed: a repository's own `.claude/commands/<name>.md` or skill could take
 * it. Computed from the stored snapshot, on the worker.
 */
export function profileSkillNames(profile: ResolvedHarnessProfile): Set<string> {
  const names = new Set<string>();
  for (const raw of profile.manifest.plugins ?? []) {
    const rel = manifestRel(raw);
    if (rel === null) {
      continue;
    }
    let plugin = rel.split('/').at(-1) ?? rel;
    const manifest = profile.files.find((f) => f.path === `${rel}/.claude-plugin/plugin.json`);
    if (manifest) {
      try {
        const parsed = JSON.parse(manifest.bytes.toString('utf8')) as { name?: unknown };
        if (typeof parsed.name === 'string' && parsed.name !== '') {
          plugin = parsed.name;
        }
      } catch {
        /* the directory's name stands */
      }
    }
    for (const file of profile.files) {
      if (!file.path.startsWith(`${rel}/`) || !file.path.endsWith('.md')) {
        continue;
      }
      const inside = file.path.slice(rel.length + 1);
      const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(inside);
      if (skill?.[1]) {
        names.add(`${plugin}:${skill[1]}`);
        const declared = frontMatterName(file.bytes);
        if (declared) {
          names.add(`${plugin}:${declared}`);
        }
      } else if (inside.startsWith('commands/')) {
        names.add(
          `${plugin}:${inside.slice('commands/'.length, -'.md'.length).replaceAll('/', ':')}`
        );
      }
    }
  }
  return names;
}

/** What {@link profileMaterializer} reports back. */
export interface ProfileMaterializer {
  /**
   * Put the approved profile into the container, every turn: stop what is
   * still running there, then remove the profile directory and write it again
   * from the worker's snapshot. A non-retryable `PROFILE_INTEGRITY` failure
   * when a path in the chain is not a real directory.
   */
  ensure(): Promise<void>;
}

const SCRIPT_REAL_DIRS = [HARNESS_DIR, PROFILES_DIR];

/**
 * Root script run before the copy. Nothing it touches is followed: a symlink
 * (or any non-directory) at the profile directory or at the directory that
 * holds it is removed, and the profile directory is emptied and recreated. A
 * link in place of the harness directory itself cannot be repaired (the binary
 * and its home live there), so it is removed and the turn fails (exit 4).
 */
function prepareScript(dir: string): string {
  const q = shellQuote;
  const replaceable = (p: string) =>
    `if [ -L ${q(p)} ] || { [ -e ${q(p)} ] && [ ! -d ${q(p)} ]; }; then rm -f -- ${q(p)}; fi`;
  return [
    'umask 022',
    `if [ -L ${q(HARNESS_DIR)} ] || { [ -e ${q(HARNESS_DIR)} ] && [ ! -d ${q(HARNESS_DIR)} ]; }; then rm -f -- ${q(HARNESS_DIR)}; exit 4; fi`,
    replaceable(PROFILES_DIR),
    replaceable(dir),
    `rm -rf -- ${q(dir)}`,
    `mkdir -p -- ${q(PROFILES_DIR)}`,
    `mkdir -- ${q(dir)}`,
    `chmod 755 ${q(dir)}`,
  ].join('\n');
}

/** Root script run after the copy: each directory on the way resolves to itself, so none is a link. */
function physicalPathScript(dir: string): string {
  return [...SCRIPT_REAL_DIRS, dir]
    .map(
      (p) => `[ "$(cd -P -- ${shellQuote(p)} 2>/dev/null && pwd -P)" = ${shellQuote(p)} ] || exit 4`
    )
    .join('\n');
}

/**
 * Puts a resolved profile into a workspace container under
 * `/workspace/.harness/profiles/<hash12>/`, outside the checkout, so `git add -A`
 * never sees it.
 *
 * Nothing the container reports is trusted: an agent running as root in its own
 * container can replace the tools a check would run (`find`, `sha256sum`) and a
 * process it detached from the turn's exec tag survives the turn's kill. So the
 * profile is not checked, it is written: before EVERY turn the stray processes
 * are stopped (everything but PID 1 and the keeper), then the profile directory
 * is removed and the worker's snapshot is written again as one ustar archive
 * the container's daemon extracts. Contents are never logged. This keeps the
 * plugin's hooks, skills and scripts from changing between turns; it does not
 * stop a process the agent starts during a turn from changing them within it.
 */
export function profileMaterializer(
  workspace: Workspace,
  profile: ResolvedHarnessProfile
): ProfileMaterializer {
  const dir = profileContainerDir(profile);

  async function install(): Promise<void> {
    if (!/^[0-9a-f]{12,}$/.test(profile.contentHash)) {
      throw integrity(profile, 'its content hash is malformed');
    }
    const archive = buildProfileTar(profile);
    await workspace.killStrays?.();
    const prepared = await workspace.execCapture(prepareScript(dir), {
      timeoutMs: SCRIPT_TIMEOUT_MS,
    });
    if (prepared.exitCode === 4) {
      throw integrity(profile, 'the harness directory is not a real directory');
    }
    if (prepared.exitCode !== 0) {
      throw new Error(
        `Could not prepare the harness profile directory (exit ${prepared.exitCode}): ${prepared.stderr.trim().slice(0, 300)}`
      );
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-profile-'));
    try {
      await fs.chmod(root, 0o700);
      const file = path.join(root, 'profile.tar');
      await fs.writeFile(file, archive, { mode: 0o600 });
      const backend = workspaceBackend();
      await backend.copyIn(backend.attach(workspace.containerId), file, dir);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
    const physical = await workspace.execCapture(physicalPathScript(dir), {
      timeoutMs: SCRIPT_TIMEOUT_MS,
    });
    if (physical.exitCode !== 0) {
      throw integrity(profile, 'its directory does not resolve to its own path in the workspace');
    }
  }

  return { ensure: install };
}
