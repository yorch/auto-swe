import { resolveSetting } from '../../config/index.js';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import {
  initialRevision,
  isRevisionConflict,
  nextRevision,
  skillContentHash,
} from '../skillRevision.js';
import { scanSkillContent } from '../skillScanner.js';
import {
  MAX_REFERENCE_FILE_BYTES,
  MAX_REFERENCE_FILES,
  parseSkillMd,
  safeDisplayPath,
} from '../skillSource/index.js';
import { ProfileNameSchema } from './manifest.js';

/** A file of an approved plugin snapshot, as {@link unpackFiles} returns it. */
export interface ProjectionFile {
  path: string;
  bytes: Buffer;
  mode: string;
}

export interface ProjectPluginSkillsInput {
  profileId: string;
  profileName: string;
  version: number;
  files: ProjectionFile[];
  /** The version's parsed `profile.json`; `plugins` lists the plugin directories. */
  manifest: { plugins?: string[] };
  /** The commit the version was read at; recorded on each projected revision as its source. */
  commitSha?: string;
  /** The user the projection runs for; recorded as the revision's author. */
  createdById?: string | null;
}

export interface ProjectPluginSkillsResult {
  created: string[];
  updated: string[];
  /** Skills left alone: hand-edited, name conflict, or scan warnings that block. */
  refused: { name: string; reason: string }[];
}

/**
 * Marks a `SkillRevision` as written by a projection (its `sourcePath` starts with this). A
 * re-projection compares the live text with the newest such revision to tell a hand edit from an
 * untouched row.
 */
export const PROJECTION_SOURCE_PREFIX = 'plugin:';

const SCAN_INCOMPLETE = 'scan-incomplete: some patterns could not be evaluated';
const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';
const SKILL_DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

interface Candidate {
  name: string;
  description: string;
  promptText: string;
  referenceFiles: { path: string; content: string }[];
  /** Where in the snapshot the skill lives, for the revision's provenance. */
  folder: string;
  scanWarnings: string[];
}

const decoder = () => new TextDecoder('utf-8', { fatal: true });

function utf8(bytes: Buffer): string | null {
  try {
    return decoder().decode(bytes);
  } catch {
    return null;
  }
}

/** Advisory scan of description then text, over every character; a failure is never "clean". */
async function scanAdvisory(description: string, promptText: string): Promise<string[]> {
  try {
    const scan = await scanSkillContent(`${description}\n${promptText}`, { full: true });
    return scan.incomplete ? [...scan.warnings, SCAN_INCOMPLETE] : scan.warnings;
  } catch {
    return [SCAN_INCOMPLETE];
  }
}

/** The plugin's name: `plugin.json`'s `name`, else its directory's. Null when neither is usable. */
function pluginNameOf(dir: string, byPath: Map<string, ProjectionFile>): string | null {
  const manifest = byPath.get(`${dir}/${PLUGIN_MANIFEST}`);
  let named: unknown;
  if (manifest) {
    const text = utf8(manifest.bytes);
    try {
      named = (JSON.parse(text ?? '') as { name?: unknown } | null)?.name;
    } catch {
      named = undefined;
    }
  }
  const candidate = typeof named === 'string' && named !== '' ? named : dir.split('/').at(-1);
  return candidate !== undefined && ProfileNameSchema.safeParse(candidate).success
    ? candidate
    : null;
}

interface Discovered {
  candidates: Candidate[];
  refused: { name: string; reason: string }[];
}

/** Parse every `skills/<dir>/SKILL.md` of every plugin; scanning happens here, before any write. */
async function discover(input: ProjectPluginSkillsInput): Promise<Discovered> {
  const byPath = new Map(input.files.map((f) => [f.path, f]));
  const candidates: Candidate[] = [];
  const refused: { name: string; reason: string }[] = [];
  const seenNames = new Set<string>();
  const seenPlugins = new Set<string>();

  for (const rawDir of input.manifest.plugins ?? []) {
    const dir = rawDir.replace(/\/+$/, '');
    const plugin = pluginNameOf(dir, byPath);
    const shownDir = safeDisplayPath(dir);
    if (plugin === null) {
      refused.push({ name: shownDir, reason: 'the plugin name is not usable in a skill name' });
      continue;
    }
    if (seenPlugins.has(plugin.toLowerCase())) {
      refused.push({ name: plugin, reason: 'another plugin of this profile has the same name' });
      continue;
    }
    seenPlugins.add(plugin.toLowerCase());

    const skillMds = input.files
      .filter((f) => {
        const rel = f.path.startsWith(`${dir}/skills/`) ? f.path.slice(dir.length + 8) : null;
        return rel !== null && /^[^/]+\/SKILL\.md$/.test(rel);
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    for (const md of skillMds) {
      const skillDir = md.path.slice(0, -'/SKILL.md'.length);
      const dirName = skillDir.split('/').at(-1) as string;
      const fallback = `${plugin}:${safeDisplayPath(dirName)}`;
      const text = utf8(md.bytes);
      if (text === null) {
        refused.push({ name: fallback, reason: 'SKILL.md is not valid UTF-8 text' });
        continue;
      }
      const parsed = parseSkillMd(text, {
        defaultName: SKILL_DIR_NAME_RE.test(dirName) ? dirName : undefined,
      });
      if (!parsed.ok) {
        refused.push({ name: fallback, reason: parsed.error });
        continue;
      }
      const name = `${plugin}:${parsed.name}`;
      if (seenNames.has(name.toLowerCase())) {
        refused.push({ name, reason: 'two skills of this profile have the same name' });
        continue;
      }
      seenNames.add(name.toLowerCase());

      const referenceFiles: { path: string; content: string }[] = [];
      for (const f of input.files) {
        if (!f.path.startsWith(`${skillDir}/`) || f.path === md.path) {
          continue;
        }
        const rel = f.path.slice(skillDir.length + 1);
        if (
          !/\.(md|txt)$/i.test(rel) ||
          CONTROL_RE.test(rel) ||
          f.bytes.length > MAX_REFERENCE_FILE_BYTES ||
          referenceFiles.length >= MAX_REFERENCE_FILES
        ) {
          continue;
        }
        const content = utf8(f.bytes);
        if (content !== null) {
          referenceFiles.push({ content, path: rel });
        }
      }
      referenceFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      candidates.push({
        description: parsed.description,
        folder: skillDir,
        name,
        promptText: parsed.promptText,
        referenceFiles,
        scanWarnings: await scanAdvisory(parsed.description, parsed.promptText),
      });
    }
  }
  return { candidates, refused };
}

type Db = PrismaClient | Prisma.TransactionClient;

// CLAUDE.md §7 exception: Prisma cannot express a transaction-scoped advisory lock. This is the
// lock the skill library, a source import and a bundle install take before they decide that a
// skill name is free (`lockSkillNames` in the gateway), under the same key, so a projection and
// any of them serialise.
const lockSkillNames = (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('skill-name-allocation', 0))`;

async function inTransaction<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if ('$transaction' in db) {
    return db.$transaction(fn, { maxWait: 10_000, timeout: 60_000 });
  }
  return fn(db);
}

/**
 * Projects the skills of an approved plugin snapshot into `Skill` rows named
 * `<plugin>:<skill>` (derived, read-only, unverified) so runtimes other than
 * `claude-code` can use them.
 *
 * - Source: each `skills/<dir>/SKILL.md` of each plugin the manifest lists, parsed with the
 *   external-source parser (frontmatter `description` required, `name` defaulting to the directory,
 *   body as the prompt text); `.md` / `.txt` siblings become reference files, stored unscanned as
 *   a source import stores them.
 * - Rows: GLOBAL, not built in, unverified, `pluginProfileId` / `pluginVersion` set. A new
 *   revision is cut only when the text or description changed, and resets `isVerified`.
 * - `skills.import.blockOnScanWarnings` (on by default) refuses a skill with scanner warnings
 *   (an incomplete scan included) and reports it in `refused`; nothing is written for it.
 * - A row whose live text differs from its newest projection revision was edited by hand and is
 *   refused, never overwritten. A skill that disappeared upstream is left installed, unreported.
 *
 * Call it after the profile version is committed: scanning runs on a worker thread and is done
 * before the write transaction opens.
 */
export async function projectPluginSkills(
  db: PrismaClient | Prisma.TransactionClient,
  input: ProjectPluginSkillsInput
): Promise<ProjectPluginSkillsResult> {
  const result: ProjectPluginSkillsResult = { created: [], refused: [], updated: [] };
  const found = await discover(input);
  result.refused.push(...found.refused);
  if (found.candidates.length === 0) {
    return result;
  }
  const block = await resolveSetting('skills.import.blockOnScanWarnings');
  const writable: Candidate[] = [];
  for (const c of found.candidates) {
    if (block && c.scanWarnings.length > 0) {
      result.refused.push({
        name: c.name,
        reason: `scanner warnings block the import (${c.scanWarnings.join(', ')})`,
      });
    } else {
      writable.push(c);
    }
  }
  if (writable.length === 0) {
    return result;
  }

  const createdById = input.createdById ?? null;
  await inTransaction(db, async (tx) => {
    await lockSkillNames(tx);
    for (const c of writable) {
      const content = { description: c.description, promptText: c.promptText };
      const meta = {
        createdById,
        referenceFiles: c.referenceFiles as unknown as Prisma.InputJsonValue,
        scanWarnings: c.scanWarnings,
        sourcePath: `${PROJECTION_SOURCE_PREFIX}${input.profileName}/${c.folder}`,
        sourceSha: input.commitSha ?? null,
      };
      const existing = await tx.skill.findFirst({ where: { name: c.name, scope: 'GLOBAL' } });
      if (!existing) {
        await tx.skill.create({
          data: {
            ...content,
            ...initialRevision(content, meta),
            // Plugin text is third-party until a human verifies a revision.
            isBuiltIn: false,
            isVerified: false,
            name: c.name,
            pluginProfileId: input.profileId,
            pluginVersion: input.version,
            scope: 'GLOBAL',
          },
        });
        result.created.push(c.name);
        continue;
      }
      if (existing.pluginProfileId !== input.profileId) {
        result.refused.push({
          name: c.name,
          reason:
            existing.pluginProfileId === null
              ? 'a skill with this name already exists and is not a plugin projection'
              : 'a skill with this name is projected from another plugin',
        });
        continue;
      }
      const projected = await tx.skillRevision.findFirst({
        orderBy: { revision: 'desc' },
        select: { contentHash: true },
        where: { skillId: existing.id, sourcePath: { startsWith: PROJECTION_SOURCE_PREFIX } },
      });
      if (!projected || projected.contentHash !== skillContentHash(existing)) {
        result.refused.push({
          name: c.name,
          reason: 'the skill was edited by hand; its text differs from the last projection',
        });
        continue;
      }
      if (skillContentHash(existing) === skillContentHash(content)) {
        if (existing.pluginVersion !== input.version) {
          await tx.skill.update({
            data: { pluginVersion: input.version },
            where: { id: existing.id },
          });
        }
        continue;
      }
      const next = nextRevision(existing, content, meta);
      try {
        await tx.skill.update({
          data: { ...next.data, isVerified: false, pluginVersion: input.version },
          where: next.where,
        });
      } catch (err) {
        if (!isRevisionConflict(err)) {
          throw err;
        }
        result.refused.push({ name: c.name, reason: 'the skill changed while it was projected' });
        continue;
      }
      result.updated.push(c.name);
    }
  });
  return result;
}
