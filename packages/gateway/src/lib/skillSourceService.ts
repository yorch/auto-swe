import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import { initialRevision } from '@auto-swe/shared/lib/skillRevision';
import {
  fetchSkillSource,
  normaliseLocation,
  type ScriptMode,
  type SkillSourceDeps,
  type SourceLocation,
  type SourceSkill,
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
  folder: string;
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

/** GLOBAL skills plus the target tenant's own: the names an agent there could see twice. */
function conflictWhere(target: SourceScope): Prisma.SkillWhereInput {
  if (target.scope === 'TEAM' && target.teamId) {
    return { OR: [{ scope: 'GLOBAL' }, { scope: 'TEAM', teamId: target.teamId }] };
  }
  if (target.scope === 'ORGANIZATION' && target.orgId) {
    return { OR: [{ scope: 'GLOBAL' }, { orgId: target.orgId, scope: 'ORGANIZATION' }] };
  }
  return { scope: 'GLOBAL' };
}

/** Existing skills a new one named `name` would collide with, in the target's own tenant view. */
async function findConflicts(
  db: Pick<PrismaClient, 'skill'>,
  names: string[],
  target: SourceScope
): Promise<Map<string, SkillConflict[]>> {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const existing = await runUnscoped('skill import checks name conflicts', ['Skill'], () =>
    db.skill.findMany({
      select: { id: true, name: true, scope: true },
      where: conflictWhere(target),
    })
  );
  const out = new Map<string, SkillConflict[]>();
  for (const row of existing) {
    const key = row.name.toLowerCase();
    if (wanted.has(key)) {
      out.set(key, [...(out.get(key) ?? []), { id: row.id, name: row.name, scope: row.scope }]);
    }
  }
  return out;
}

/** A scan that reads the setting once; the setting is GLOBAL-only. */
async function scanAll(skills: SourceSkill[]): Promise<Map<SourceSkill, string[]>> {
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
      const skillConflicts = s.name === null ? [] : (conflicts.get(s.name.toLowerCase()) ?? []);
      const blockedByScan = block && scanWarnings.length > 0;
      return {
        blockedByScan,
        conflicts: skillConflicts,
        description: s.description,
        errors: s.errors,
        folder: s.folder,
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
    readonly code: 'NAME_CONFLICT' | 'NOT_INSTALLABLE' | 'SCAN_WARNINGS' | 'UNKNOWN_SKILLS',
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
    source: { id: string },
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

  const byName = new Map(
    fetched.skills.flatMap((s) => (s.name === null ? [] : [[s.name, s] as const]))
  );
  const wanted = [...new Set(input.skills)];
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

  return prisma.$transaction(
    async (tx) => {
      // Inside the transaction, immediately before the writes, so the decision
      // is taken on the rows the writes then sit beside.
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
      const installed: InstalledSkill[] = [];
      for (const s of chosen) {
        const content = { description: s.description, promptText: s.promptText };
        const skill = await tx.skill.create({
          data: {
            ...content,
            ...initialRevision(content, {
              createdById: input.createdById,
              referenceFiles: s.referenceFiles as unknown as Prisma.InputJsonValue,
              scanWarnings: scans.get(s) ?? [],
              sourcePath: s.folder,
              sourceSha: fetched.sha,
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
      await audit(tx, source, installed);
      return { installed, source };
    },
    { maxWait: 10_000, timeout: 60_000 }
  );
}
