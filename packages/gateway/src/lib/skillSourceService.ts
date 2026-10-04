import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { initialRevision } from '@auto-swe/shared/lib/skillRevision';
import {
  fetchSkillSource,
  normaliseLocation,
  normaliseSkillName,
  type ScriptMode,
  type SkillSourceDeps,
  type SourceLocation,
  type SourceSkill,
  safeDisplayPath,
} from '@auto-swe/shared/lib/skillSource';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import { scanSkillAdvisory } from './skillScan.js';

/**
 * Importing skills from an external git source: the read-only preview and the
 * one-transaction install. HTTP status mapping and audit stay with the routes.
 */

export interface SourceScope {
  scope: 'GLOBAL' | 'ORGANIZATION' | 'TEAM';
  teamId: string | null;
  orgId: string | null;
}

export interface SkillConflict {
  id: string;
  name: string;
  scope: string;
}

export interface PreviewSkill {
  /** Control characters replaced: the folder is repository-controlled text. */
  folder: string;
  /** Frontmatter keys (e.g. `allowed-tools`) that the import reads nothing from. */
  ignoredKeys: string[];
  name: string | null;
  description: string | null;
  textLength: number;
  referenceFileCount: number;
  skippedFiles: SourceSkill['skippedFiles'];
  scanWarnings: string[];
  conflicts: SkillConflict[];
  errors: string[];
  /** Refused only because `skills.import.blockOnScanWarnings` is on and it has warnings. */
  blockedByScan: boolean;
  installable: boolean;
}

/**
 * Every skill an agent in the target tenant could see beside the new one — and,
 * for a GLOBAL or ORGANIZATION import, every tenant it would become visible to:
 *
 * - GLOBAL: every skill, at any scope (it is visible to every team).
 * - ORGANIZATION: GLOBAL, the organization's own, and those of every team in it.
 * - TEAM: GLOBAL, its organization's, and its own team's.
 */
async function conflictWhere(
  db: Pick<PrismaClient, 'team'>,
  target: SourceScope
): Promise<Prisma.SkillWhereInput> {
  if (target.scope === 'ORGANIZATION' && target.orgId) {
    return {
      OR: [
        { scope: 'GLOBAL' },
        { orgId: target.orgId, scope: 'ORGANIZATION' },
        { scope: 'TEAM', team: { orgId: target.orgId } },
      ],
    };
  }
  if (target.scope === 'TEAM' && target.teamId) {
    const team = await db.team.findUnique({
      select: { orgId: true },
      where: { id: target.teamId },
    });
    return {
      OR: [
        { scope: 'GLOBAL' },
        ...(team?.orgId ? [{ orgId: team.orgId, scope: 'ORGANIZATION' as const }] : []),
        { scope: 'TEAM', teamId: target.teamId },
      ],
    };
  }
  return {};
}

/** Existing skills a new one named `name` would collide with (see {@link conflictWhere}). */
export async function findConflicts(
  db: Pick<PrismaClient, 'skill' | 'team'>,
  names: string[],
  target: SourceScope
): Promise<Map<string, SkillConflict[]>> {
  const wanted = new Set(names.map(normaliseSkillName));
  const where = await conflictWhere(db, target);
  const existing = await runUnscoped('skill import checks name conflicts', ['Skill'], () =>
    db.skill.findMany({ select: { id: true, name: true, scope: true }, where })
  );
  const out = new Map<string, SkillConflict[]>();
  for (const row of existing) {
    const key = normaliseSkillName(row.name);
    if (wanted.has(key)) {
      out.set(key, [...(out.get(key) ?? []), { id: row.id, name: row.name, scope: row.scope }]);
    }
  }
  return out;
}

/** A scan that reads the setting once; the setting is GLOBAL-only. */
export async function scanAll(skills: SourceSkill[]): Promise<Map<SourceSkill, string[]>> {
  const scans = new Map<SourceSkill, string[]>();
  for (const s of skills) {
    if (s.errors.length === 0 && s.name !== null) {
      scans.set(s, await scanSkillAdvisory(s.description, s.promptText));
    }
  }
  return scans;
}

export async function previewSkillSource(
  prisma: PrismaClient,
  input: SourceLocation & { scriptMode: ScriptMode } & SourceScope,
  deps?: SkillSourceDeps
): Promise<{ sha: string; location: SourceLocation; skills: PreviewSkill[] }> {
  const location = normaliseLocation(input);
  const fetched = await fetchSkillSource(location, { scriptMode: input.scriptMode }, deps);
  const [scans, block] = await Promise.all([
    scanAll(fetched.skills),
    resolveSetting('skills.import.blockOnScanWarnings'),
  ]);
  const names = fetched.skills.flatMap((s) => (s.name === null ? [] : [s.name]));
  const conflicts = await findConflicts(prisma, names, input);
  return {
    location,
    sha: fetched.sha,
    skills: fetched.skills.map((s) => {
      const scanWarnings = scans.get(s) ?? [];
      const skillConflicts =
        s.name === null ? [] : (conflicts.get(normaliseSkillName(s.name)) ?? []);
      const blockedByScan = block && scanWarnings.length > 0;
      return {
        blockedByScan,
        conflicts: skillConflicts,
        description: s.description,
        errors: s.errors,
        folder: safeDisplayPath(s.folder),
        ignoredKeys: s.ignoredKeys,
        installable: s.errors.length === 0 && skillConflicts.length === 0 && !blockedByScan,
        name: s.name,
        referenceFileCount: s.referenceFiles.length,
        scanWarnings,
        skippedFiles: s.skippedFiles,
        textLength: s.promptText.length,
      };
    }),
  };
}

/** The install cannot proceed as asked; `code` selects the HTTP status in the route. */
export class SkillImportRefusal extends Error {
  constructor(
    readonly code:
      | 'ALREADY_INSTALLED'
      | 'DISABLED'
      | 'NAME_CONFLICT'
      | 'NOT_INSTALLABLE'
      | 'SCAN_WARNINGS'
      | 'SOURCE_CHANGED'
      | 'STALE_SHA'
      | 'UNKNOWN_SKILLS',
    readonly details: unknown
  ) {
    super(code);
    this.name = 'SkillImportRefusal';
  }
}

export type SkillSourceRow = NonNullable<
  Awaited<ReturnType<PrismaClient['skillSource']['findFirst']>>
>;

export interface InstalledSkill {
  id: string;
  name: string;
  revision: number;
}

/**
 * The skills the request names, checked against what the source holds: names
 * folded together, unknown names, skills with errors and (when the setting
 * blocks them) scan warnings are each refused, naming everything at once.
 */
async function chooseSkills(fetchedSkills: SourceSkill[], names: string[]) {
  const byName = new Map(
    fetchedSkills.flatMap((s) => (s.name === null ? [] : [[s.name, s] as const]))
  );
  const wanted = [...new Set(names)];
  if (new Set(wanted.map(normaliseSkillName)).size !== wanted.length) {
    throw new SkillImportRefusal(
      'NAME_CONFLICT',
      wanted.map((name) => ({ name, scope: 'this import' }))
    );
  }
  const unknown = wanted.filter((n) => !byName.has(n));
  if (unknown.length > 0) {
    throw new SkillImportRefusal('UNKNOWN_SKILLS', unknown);
  }
  const chosen = wanted.map((n) => byName.get(n) as SourceSkill);

  const broken = chosen.filter((s) => s.errors.length > 0);
  if (broken.length > 0) {
    throw new SkillImportRefusal(
      'NOT_INSTALLABLE',
      broken.map((s) => ({ errors: s.errors, name: s.name }))
    );
  }

  const [scans, block] = await Promise.all([
    scanAll(chosen),
    resolveSetting('skills.import.blockOnScanWarnings'),
  ]);
  const flagged = chosen.filter((s) => (scans.get(s) ?? []).length > 0);
  if (block && flagged.length > 0) {
    throw new SkillImportRefusal(
      'SCAN_WARNINGS',
      flagged.map((s) => ({ name: s.name, warnings: scans.get(s) }))
    );
  }
  return { chosen, scans, wanted };
}

/** The skill rows and their revision 1, written inside the caller's transaction. */
async function createSkillRows(
  tx: Prisma.TransactionClient,
  source: SkillSourceRow,
  chosen: SourceSkill[],
  scans: Map<SourceSkill, string[]>,
  sha: string,
  createdById: string
): Promise<InstalledSkill[]> {
  const installed: InstalledSkill[] = [];
  for (const s of chosen) {
    const content = { description: s.description, promptText: s.promptText };
    const skill = await tx.skill.create({
      data: {
        ...content,
        ...initialRevision(content, {
          createdById,
          // Reference files are stored UNSCANNED (the scan covers description and
          // text). Nothing reads them back to an agent or a UI; whatever first does
          // must scan them, with blockOnScanWarnings applying, before it may.
          referenceFiles: s.referenceFiles as unknown as Prisma.InputJsonValue,
          scanWarnings: scans.get(s) ?? [],
          sourcePath: s.folder,
          sourceSha: sha,
        }),
        // Imported text is third-party until a human verifies a revision.
        isBuiltIn: false,
        isVerified: false,
        name: s.name as string,
        orgId: source.orgId,
        scope: source.scope,
        sourceId: source.id,
        sourcePath: s.folder,
        teamId: source.teamId,
      },
    });
    installed.push({ id: skill.id, name: skill.name, revision: 1 });
  }
  return installed;
}

// CLAUDE.md §7 exception: Prisma cannot express a transaction-scoped advisory lock.
// `skills` has no unique name, so two concurrent imports could both find a name
// free; this serialises the check-then-create of every import.
const lockSkillNames = (tx: Prisma.TransactionClient) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('skill-name-allocation', 0))`;

/**
 * Install the chosen skills from a source at one commit.
 *
 * Content is re-read from the host at `sha` — the request names skills, it never
 * supplies text — and the ref must still resolve to `sha` (else `SHA_MOVED`).
 * Refusals are all-or-nothing and name everything at once: unknown names,
 * skills with errors, scan warnings (when the setting blocks them) and name
 * conflicts. The source row, every skill with its revision 1, and whatever
 * `audit` writes happen in one transaction, so a failure midway leaves nothing.
 */
export async function installSkillSource(
  prisma: PrismaClient,
  input: SourceLocation &
    SourceScope & {
      scriptMode: ScriptMode;
      sha: string;
      skills: string[];
      createdById: string;
    },
  audit: (
    tx: Prisma.TransactionClient,
    source: SkillSourceRow,
    skills: InstalledSkill[]
  ) => Promise<void>,
  deps?: SkillSourceDeps
): Promise<{ installed: InstalledSkill[]; source: SkillSourceRow }> {
  const location = normaliseLocation(input);
  const fetched = await fetchSkillSource(
    location,
    { expectSha: input.sha, scriptMode: input.scriptMode },
    deps
  );

  const { chosen, scans, wanted } = await chooseSkills(fetched.skills, input.skills);

  return prisma.$transaction(
    async (tx) => {
      // Inside the transaction, immediately before the writes, so the decision
      // is taken on the rows the writes then sit beside.
      await lockSkillNames(tx);
      const conflicts = await findConflicts(tx, wanted, input);
      if (conflicts.size > 0) {
        throw new SkillImportRefusal(
          'NAME_CONFLICT',
          [...conflicts.values()]
            .flat()
            .map((c) => ({ existingId: c.id, name: c.name, scope: c.scope }))
        );
      }
      const source = await tx.skillSource.create({
        data: {
          createdById: input.createdById,
          host: location.host,
          lastCheckedAt: new Date(),
          latestSha: fetched.sha,
          orgId: input.scope === 'ORGANIZATION' ? input.orgId : null,
          owner: location.owner,
          path: location.path,
          pinnedSha: fetched.sha,
          ref: location.ref,
          repo: location.repo,
          scope: input.scope,
          scriptMode: input.scriptMode,
          teamId: input.scope === 'TEAM' ? input.teamId : null,
        },
      });
      const installed = await createSkillRows(
        tx,
        source,
        chosen,
        scans,
        fetched.sha,
        input.createdById
      );
      await audit(tx, source, installed);
      return { installed, source };
    },
    { maxWait: 10_000, timeout: 60_000 }
  );
}

/**
 * Serialises an install and an accept on one source. Both read the installed set and
 * the pin before they write, so without it an install that commits while an accept is
 * scanning leaves a skill behind a pin that then reads up to date. Taken first, before
 * the name lock where a transaction needs both, so the two locks cannot deadlock.
 */
// CLAUDE.md §7 exception: Prisma cannot express a transaction-scoped advisory lock.
export const lockSkillSource = (tx: Prisma.TransactionClient, sourceId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`skill-source:${sourceId}`}, 0))`;

/**
 * Install more skills from a source that already exists: the folders its pinned
 * commit holds that nothing installed uses (never chosen at import).
 *
 * `sha` must be the source's `pinnedSha` — the commit it is installed at — and is
 * read by sha, never through the ref, so what is installed is the pinned text
 * and the pin never has to move. A folder first added upstream after the pin is
 * therefore `UNKNOWN_SKILLS` until an accept advances the pin. The rules are
 * those of the first import: all-or-nothing, scan warnings blocked by the
 * setting, name conflicts decided under the same lock inside the transaction.
 * The source is re-read inside the transaction, so one disabled, deleted or
 * moved meanwhile is `SOURCE_CHANGED` and nothing is written.
 */
export async function installIntoSource(
  prisma: PrismaClient,
  source: SkillSourceRow,
  input: { sha: string; skills: string[]; createdById: string },
  audit: (
    tx: Prisma.TransactionClient,
    source: SkillSourceRow,
    skills: InstalledSkill[]
  ) => Promise<void>,
  deps?: SkillSourceDeps
): Promise<{ installed: InstalledSkill[]; source: SkillSourceRow }> {
  if (source.status === 'DISABLED') {
    throw new SkillImportRefusal('DISABLED', undefined);
  }
  if (source.pinnedSha !== input.sha) {
    throw new SkillImportRefusal('STALE_SHA', { pinnedSha: source.pinnedSha });
  }
  const fetched = await fetchSkillSource(
    {
      host: source.host,
      owner: source.owner,
      path: source.path,
      ref: source.ref,
      repo: source.repo,
    },
    { atSha: input.sha, scriptMode: source.scriptMode },
    deps
  );
  const { chosen, scans, wanted } = await chooseSkills(fetched.skills, input.skills);

  return prisma.$transaction(
    async (tx) => {
      await lockSkillSource(tx, source.id);
      await lockSkillNames(tx);
      const current = await tx.skillSource.findUnique({ where: { id: source.id } });
      if (
        !current ||
        current.status === 'DISABLED' ||
        current.pinnedSha !== input.sha ||
        // The folders were read in the mode the row had before the transaction.
        current.scriptMode !== source.scriptMode
      ) {
        throw new SkillImportRefusal('SOURCE_CHANGED', undefined);
      }
      const taken = await runUnscoped(
        'skill install checks the folders of one source',
        ['Skill'],
        () =>
          tx.skill.findMany({
            select: { name: true },
            where: { sourceId: source.id, sourcePath: { in: chosen.map((s) => s.folder) } },
          })
      );
      if (taken.length > 0) {
        throw new SkillImportRefusal(
          'ALREADY_INSTALLED',
          taken.map((t) => ({ name: t.name }))
        );
      }
      // A source is only ever created GLOBAL, ORGANIZATION or TEAM (a CHECK keeps it so).
      const conflicts = await findConflicts(tx, wanted, {
        orgId: current.orgId,
        scope: current.scope as SourceScope['scope'],
        teamId: current.teamId,
      });
      if (conflicts.size > 0) {
        throw new SkillImportRefusal(
          'NAME_CONFLICT',
          [...conflicts.values()]
            .flat()
            .map((c) => ({ existingId: c.id, name: c.name, scope: c.scope }))
        );
      }
      const installed = await createSkillRows(
        tx,
        current,
        chosen,
        scans,
        input.sha,
        input.createdById
      );
      await audit(tx, current, installed);
      return { installed, source: current };
    },
    { maxWait: 10_000, timeout: 60_000 }
  );
}
