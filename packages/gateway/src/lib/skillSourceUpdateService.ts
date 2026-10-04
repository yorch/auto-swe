import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@auto-swe/shared';
import { resolveSetting } from '@auto-swe/shared/config';
import {
  isRevisionConflict,
  nextRevision,
  skillContentHash,
} from '@auto-swe/shared/lib/skillRevision';
import {
  fetchSkillSource,
  normaliseSkillName,
  type SkillSourceDeps,
  type SourceSkill,
  safeDisplayPath,
} from '@auto-swe/shared/lib/skillSource';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';
import {
  findConflicts,
  lockSkillSource,
  type SkillSourceRow,
  type SourceScope,
  scanAll,
} from './skillSourceService.js';
import { type TextDiff, unifiedDiff } from './textDiff.js';

/**
 * Reviewing and accepting an update to a tracked skill source.
 *
 * The model is pinned-and-reviewed: the sweep only flags that the ref moved; an
 * admin reads {@link diffSkillSource} and then {@link acceptSkillUpdate}, which
 * cuts a new immutable `SkillRevision` per accepted skill. Workflows already
 * running keep the revision they pinned at start.
 *
 * "Upstream baseline" of a skill is its latest *pristine* revision: one cut by
 * an import or an accept (it is the first revision to carry its source sha with
 * that content). A description-only hand edit copies the sha onto its own
 * revision but changes the content, so it is not pristine; a text edit drops
 * the sha altogether. A skill is hand-edited when its live content differs from
 * that baseline — which tells "upstream changed" from "an admin changed it"
 * without fetching the old commit.
 */

interface RevisionRow {
  revision: number;
  sourceSha: string | null;
  contentHash: string;
  referenceFiles: unknown;
}

interface InstalledRow {
  id: string;
  name: string;
  sourcePath: string | null;
  currentRevision: number;
  description: string | null;
  promptText: string;
  revisions: RevisionRow[];
}

interface RefFile {
  path: string;
  content: string;
}

const asRefFiles = (raw: unknown): RefFile[] =>
  Array.isArray(raw)
    ? raw.flatMap((r) => {
        const f = r as { content?: unknown; path?: unknown };
        return typeof f?.path === 'string' && typeof f.content === 'string'
          ? [{ content: f.content, path: f.path }]
          : [];
      })
    : [];

const refsHash = (files: RefFile[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        [...files].sort((a, b) => a.path.localeCompare(b.path)).map((f) => [f.path, f.content])
      )
    )
    .digest('hex');

/** The latest revision an import or an accept cut; null if none can be identified. */
function pristineBaseline(revisions: RevisionRow[]): RevisionRow | null {
  const pristine = revisions.filter(
    (r) =>
      r.sourceSha !== null &&
      revisions.every(
        (e) =>
          e.revision >= r.revision || e.sourceSha !== r.sourceSha || e.contentHash === r.contentHash
      )
  );
  return pristine.reduce<RevisionRow | null>(
    (best, r) => (best === null || r.revision > best.revision ? r : best),
    null
  );
}

interface ChangedItem {
  installed: InstalledRow;
  upstream: SourceSkill;
  handEdited: boolean;
  referenceFilesChanged: boolean;
  /** The name upstream's frontmatter now gives, when it differs; the installed name is kept. */
  renamedTo: string | null;
}

interface UpdatePlan {
  unchanged: Array<{ installed: InstalledRow; handEdited: boolean; renamedTo: string | null }>;
  changed: ChangedItem[];
  /** Installed here, but upstream no longer parses (or is rejected by the script mode). */
  errors: Array<{ installed: InstalledRow; upstream: SourceSkill }>;
  /** Installed, and its folder is no longer in the source. */
  removed: InstalledRow[];
  /** In the source, installed by nothing: new upstream, or never chosen at import. */
  added: SourceSkill[];
}

async function loadInstalled(
  prisma: Pick<PrismaClient, 'skill'>,
  sourceId: string
): Promise<InstalledRow[]> {
  return runUnscoped('skill source update reads the skills of one source', ['Skill'], () =>
    prisma.skill.findMany({
      orderBy: { name: 'asc' },
      select: {
        currentRevision: true,
        description: true,
        id: true,
        name: true,
        promptText: true,
        revisions: {
          orderBy: { revision: 'asc' },
          select: { contentHash: true, referenceFiles: true, revision: true, sourceSha: true },
        },
        sourcePath: true,
      },
      where: { sourceId },
    })
  );
}

function planUpdate(installed: InstalledRow[], fetched: SourceSkill[]): UpdatePlan {
  const byFolder = new Map(fetched.map((s) => [s.folder, s]));
  const used = new Set<string>();
  const plan: UpdatePlan = { added: [], changed: [], errors: [], removed: [], unchanged: [] };
  for (const inst of installed) {
    const up = inst.sourcePath === null ? undefined : byFolder.get(inst.sourcePath);
    if (!up) {
      plan.removed.push(inst);
      continue;
    }
    used.add(up.folder);
    if (up.errors.length > 0 || up.name === null) {
      plan.errors.push({ installed: inst, upstream: up });
      continue;
    }
    const liveHash = skillContentHash(inst);
    const baseline = pristineBaseline(inst.revisions);
    const upstreamHash = skillContentHash({
      description: up.description,
      promptText: up.promptText,
    });
    // No identifiable baseline: all that can be said is how it differs from live,
    // and it cannot be proven untouched, so it counts as hand-edited.
    const handEdited = baseline === null || baseline.contentHash !== liveHash;
    const referenceFilesChanged =
      baseline === null ||
      refsHash(asRefFiles(baseline.referenceFiles)) !== refsHash(up.referenceFiles);
    const upstreamChanged =
      baseline === null ? liveHash !== upstreamHash : baseline.contentHash !== upstreamHash;
    const renamedTo = up.name === inst.name ? null : up.name;
    if (upstreamChanged || referenceFilesChanged) {
      plan.changed.push({
        handEdited,
        installed: inst,
        referenceFilesChanged,
        renamedTo,
        upstream: up,
      });
    } else {
      plan.unchanged.push({ handEdited, installed: inst, renamedTo });
    }
  }
  plan.added = fetched.filter((s) => !used.has(s.folder));
  return plan;
}

const locationOf = (s: SkillSourceRow) => ({
  host: s.host,
  owner: s.owner,
  path: s.path,
  ref: s.ref,
  repo: s.repo,
});

/**
 * The text diff of each given skill. Every skill gets its own fixed work budget,
 * so whether its diff is complete depends only on its own old and new text: the
 * diff the admin read and the accept's check agree whatever the other skills
 * (or the live text of ones that are not chosen) look like.
 */
function computeDiffs(changed: ChangedItem[]): Map<ChangedItem, TextDiff> {
  return new Map(
    changed.map((c) => [c, unifiedDiff(c.installed.promptText, c.upstream.promptText)])
  );
}

/** A diff the admin cannot read in full: cut, or never computed. */
const incomplete = (d: TextDiff | undefined) => !!d && (d.truncated || d.tooLarge);

function referenceChanges(before: RefFile[], after: RefFile[]) {
  const old = new Map(before.map((f) => [f.path, f.content]));
  const next = new Map(after.map((f) => [f.path, f.content]));
  return {
    added: [...next.keys()].filter((p) => !old.has(p)).map(safeDisplayPath),
    changed: [...next.keys()]
      .filter((p) => old.has(p) && old.get(p) !== next.get(p))
      .map(safeDisplayPath),
    removed: [...old.keys()].filter((p) => !next.has(p)).map(safeDisplayPath),
  };
}

/**
 * The per-skill diff between what is installed and what the source holds at
 * `sha`. Reads the host (budgeted like any import) and the database; writes nothing.
 *
 * For a changed skill the diff is a unified text diff of the live prompt text
 * against the incoming one, beside both descriptions. A diff shows the change a
 * reviewer has to judge in a few lines where two full texts (up to 50 000
 * characters each, for up to 100 skills) would bury it; the live side is
 * included deliberately, so an accept that would overwrite a hand edit shows
 * that edit being reverted.
 */
export async function diffSkillSource(
  prisma: PrismaClient,
  source: SkillSourceRow,
  sha: string,
  deps?: SkillSourceDeps
) {
  const fetched = await fetchSkillSource(
    locationOf(source),
    { atSha: sha, scriptMode: source.scriptMode },
    deps
  );
  const installed = await loadInstalled(prisma, source.id);
  const plan = planUpdate(installed, fetched.skills);
  const [scans, block] = await Promise.all([
    scanAll([...plan.changed.map((c) => c.upstream), ...plan.added]),
    resolveSetting('skills.import.blockOnScanWarnings'),
  ]);
  const scanOf = (s: SourceSkill) => scans.get(s) ?? [];
  const diffs = computeDiffs(plan.changed);
  // What an install of each added skill would collide with, decided as the install decides it.
  const conflicts = await findConflicts(
    prisma,
    plan.added.flatMap((s) => (s.name === null ? [] : [s.name])),
    {
      orgId: source.orgId,
      scope: source.scope as SourceScope['scope'],
      teamId: source.teamId,
    }
  );

  return {
    added: plan.added.map((s) => ({
      blockedByScan: block && scanOf(s).length > 0,
      conflicts: s.name === null ? [] : (conflicts.get(normaliseSkillName(s.name)) ?? []),
      description: s.description,
      errors: s.errors,
      folder: safeDisplayPath(s.folder),
      ignoredKeys: s.ignoredKeys,
      name: s.name,
      referenceFileCount: s.referenceFiles.length,
      scanWarnings: scanOf(s),
      skippedFiles: s.skippedFiles,
      textLength: s.promptText.length,
    })),
    changed: plan.changed.map((c) => {
      const diff = diffs.get(c) as TextDiff;
      const scanWarnings = scanOf(c.upstream);
      return {
        blockedByScan: block && scanWarnings.length > 0,
        description: {
          changed: c.installed.description !== c.upstream.description,
          new: c.upstream.description,
          old: c.installed.description,
        },
        diffIncomplete: incomplete(diff),
        diffTooLarge: diff.tooLarge,
        folder: safeDisplayPath(c.upstream.folder),
        handEdited: c.handEdited,
        ignoredKeys: c.upstream.ignoredKeys,
        installedRevision: c.installed.currentRevision,
        name: c.installed.name,
        referenceFiles: referenceChanges(
          asRefFiles(pristineBaseline(c.installed.revisions)?.referenceFiles ?? []),
          c.upstream.referenceFiles
        ),
        renamedTo: c.renamedTo,
        scanWarnings,
        skillId: c.installed.id,
        skippedFiles: c.upstream.skippedFiles,
        textDiff: diff.text,
        textDiffTruncated: diff.truncated,
        textLength: { new: c.upstream.promptText.length, old: c.installed.promptText.length },
      };
    }),
    errors: plan.errors.map((e) => ({
      errors: e.upstream.errors,
      folder: safeDisplayPath(e.upstream.folder),
      name: e.installed.name,
      skillId: e.installed.id,
    })),
    removed: plan.removed.map((r) => ({
      folder: safeDisplayPath(r.sourcePath ?? ''),
      name: r.name,
      skillId: r.id,
    })),
    sha: fetched.sha,
    unchanged: plan.unchanged.map((u) => ({
      handEdited: u.handEdited,
      name: u.installed.name,
      renamedTo: u.renamedTo,
      skillId: u.installed.id,
    })),
  };
}

/**
 * The complete incoming text of one skill at `sha` (by installed name, or by the
 * name upstream gives it), for the review a truncated or too-large diff could
 * not show. Writes nothing.
 */
export async function readIncomingSkill(
  prisma: PrismaClient,
  source: SkillSourceRow,
  sha: string,
  name: string,
  deps?: SkillSourceDeps
) {
  const fetched = await fetchSkillSource(
    locationOf(source),
    { atSha: sha, scriptMode: source.scriptMode },
    deps
  );
  const installed = await loadInstalled(prisma, source.id);
  const folder = installed.find((i) => i.name === name)?.sourcePath;
  const upstream = fetched.skills.find((s) => (folder ? s.folder === folder : s.name === name));
  if (!upstream) {
    throw new SkillUpdateRefusal('UNKNOWN_SKILLS', [name]);
  }
  return {
    description: upstream.description,
    errors: upstream.errors,
    folder: safeDisplayPath(upstream.folder),
    name: upstream.name,
    promptText: upstream.promptText,
    referenceFiles: upstream.referenceFiles.map((f) => ({
      length: f.content.length,
      path: safeDisplayPath(f.path),
    })),
    sha: fetched.sha,
  };
}

/** The accept cannot proceed as asked; `code` selects the HTTP status in the route. */
export class SkillUpdateRefusal extends Error {
  constructor(
    readonly code:
      | 'DIFF_INCOMPLETE'
      | 'DISABLED'
      | 'NOT_CHECKED'
      | 'NOT_INSTALLABLE'
      | 'SCAN_WARNINGS'
      | 'SKILL_CHANGED'
      | 'SOURCE_CHANGED'
      | 'STALE_SHA'
      | 'UNKNOWN_SKILLS',
    readonly details: unknown = undefined
  ) {
    super(code);
    this.name = 'SkillUpdateRefusal';
  }
}

export interface AcceptedSkill {
  id: string;
  name: string;
  fromRevision: number;
  revision: number;
}

export interface AcceptSummary {
  sha: string;
  before: { pinnedSha: string; status: string };
  after: { pinnedSha: string; status: 'OK' | 'UPDATE_AVAILABLE' };
  accepted: AcceptedSkill[];
  /** Skills whose upstream frontmatter name differs; the installed name is kept. */
  renamed: Array<{ name: string; renamedTo: string }>;
  /** Changed upstream and hand-edited here, and not named in `skills`: left as they are. */
  conflicts: string[];
  /** Changed upstream and not hand-edited, but left out because `skills` did not name them. */
  notSelected: string[];
  /** Changed upstream, but no longer parse: left as they are. */
  unreadable: string[];
  /** No longer in the source: flagged only, never deleted. */
  removed: string[];
  /** Folders in the source that nothing installed uses (not installed by an accept). */
  added: string[];
  /** Whether the pin moved: only when nothing that changed upstream was left behind. */
  pinAdvanced: boolean;
}

/**
 * Accept the update at `sha` for the chosen skills, in one transaction.
 *
 * `sha` must be the source's `latestSha` — the commit the admin diffed — and is
 * read by sha, never through the ref. Without `names`, every changed skill is
 * updated except hand-edited ones, which are reported as conflicts; naming a
 * hand-edited skill in `names` is the explicit overwrite. Each accepted skill
 * gets a new revision (provenance set, unverified) through the same
 * revision-guarded write a hand edit uses: an edit that lands meanwhile makes
 * the whole accept fail with `SKILL_CHANGED` and nothing is written.
 *
 * The pin moves to `sha` only when every skill that changed upstream was
 * updated. Otherwise it stays, the source stays UPDATE_AVAILABLE, and the next
 * diff still lists what was left — a pin that advanced past an un-updated skill
 * would report "up to date" while a skill sat behind.
 */
export async function acceptSkillUpdate(
  prisma: PrismaClient,
  source: SkillSourceRow,
  input: {
    sha: string;
    /** Skills to update, each bound to the installed revision the admin saw in the diff. */
    skills?: Array<{ name: string; revision: number }>;
    actorId: string;
  },
  audit: (tx: Prisma.TransactionClient, summary: AcceptSummary) => Promise<void>,
  deps?: SkillSourceDeps
): Promise<AcceptSummary> {
  if (source.status === 'DISABLED') {
    throw new SkillUpdateRefusal('DISABLED');
  }
  if (source.latestSha === null) {
    throw new SkillUpdateRefusal('NOT_CHECKED');
  }
  if (source.latestSha !== input.sha) {
    throw new SkillUpdateRefusal('STALE_SHA', { latestSha: source.latestSha });
  }
  const fetched = await fetchSkillSource(
    locationOf(source),
    { atSha: input.sha, scriptMode: source.scriptMode },
    deps
  );
  const installed = await loadInstalled(prisma, source.id);
  const plan = planUpdate(installed, fetched.skills);

  const named = new Map((input.skills ?? []).map((s) => [s.name, s.revision]));
  const explicit = input.skills ? [...named.keys()] : null;
  if (explicit) {
    const known = new Map(installed.map((i) => [i.name, i]));
    const unknown = explicit.filter((n) => !known.has(n));
    if (unknown.length > 0) {
      throw new SkillUpdateRefusal('UNKNOWN_SKILLS', unknown);
    }
    // The live side the admin reviewed: a skill edited since is not overwritten unseen.
    const moved = explicit.filter((n) => known.get(n)?.currentRevision !== named.get(n));
    if (moved.length > 0) {
      throw new SkillUpdateRefusal('SKILL_CHANGED', { names: moved });
    }
    const broken = explicit.filter(
      (n) =>
        plan.errors.some((e) => e.installed.name === n) || plan.removed.some((r) => r.name === n)
    );
    if (broken.length > 0) {
      throw new SkillUpdateRefusal(
        'NOT_INSTALLABLE',
        broken.map((name) => ({
          errors: plan.errors.find((e) => e.installed.name === name)?.upstream.errors ?? [
            'no longer in the source',
          ],
          name,
        }))
      );
    }
  }
  const chosen = plan.changed.filter((c) =>
    explicit ? explicit.includes(c.installed.name) : !c.handEdited
  );

  // A diff the admin could not read in full cannot be accepted by default: it has to
  // be named, which says the full text (`full=true` on the diff) was read.
  const diffs = computeDiffs(chosen);
  const unread = chosen.filter(
    (c) => incomplete(diffs.get(c)) && !(explicit ?? []).includes(c.installed.name)
  );
  if (unread.length > 0) {
    throw new SkillUpdateRefusal(
      'DIFF_INCOMPLETE',
      unread.map((c) => c.installed.name)
    );
  }

  const [scans, block] = await Promise.all([
    scanAll(chosen.map((c) => c.upstream)),
    resolveSetting('skills.import.blockOnScanWarnings'),
  ]);
  const flagged = chosen.filter((c) => (scans.get(c.upstream) ?? []).length > 0);
  if (block && flagged.length > 0) {
    throw new SkillUpdateRefusal(
      'SCAN_WARNINGS',
      flagged.map((c) => ({ name: c.installed.name, warnings: scans.get(c.upstream) }))
    );
  }

  const leftBehind = plan.changed.length - chosen.length + plan.errors.length;
  const pinAdvanced = leftBehind === 0;
  const after = {
    pinnedSha: pinAdvanced ? input.sha : source.pinnedSha,
    status: pinAdvanced ? ('OK' as const) : ('UPDATE_AVAILABLE' as const),
  };

  return prisma.$transaction(
    async (tx) => {
      await lockSkillSource(tx, source.id);
      // An install that committed since the plan was made would leave a skill the plan
      // never saw behind a pin this accept moves.
      const now = await loadInstalled(tx, source.id);
      const key = (rows: InstalledRow[]) =>
        rows
          .map((r) => `${r.id}\0${r.sourcePath}`)
          .sort()
          .join('\n');
      if (key(now) !== key(installed)) {
        throw new SkillUpdateRefusal('SOURCE_CHANGED');
      }
      const accepted: AcceptedSkill[] = [];
      for (const c of chosen) {
        const next = nextRevision(
          c.installed,
          { description: c.upstream.description, promptText: c.upstream.promptText },
          {
            createdById: input.actorId,
            referenceFiles: c.upstream.referenceFiles as unknown as Prisma.InputJsonValue,
            scanWarnings: scans.get(c.upstream) ?? [],
            sourcePath: c.upstream.folder,
            sourceSha: input.sha,
          }
        );
        try {
          await tx.skill.update({ data: { ...next.data, isVerified: false }, where: next.where });
        } catch (err) {
          if (isRevisionConflict(err)) {
            throw new SkillUpdateRefusal('SKILL_CHANGED', { name: c.installed.name });
          }
          throw err;
        }
        accepted.push({
          fromRevision: c.installed.currentRevision,
          id: c.installed.id,
          name: c.installed.name,
          revision: c.installed.currentRevision + 1,
        });
      }
      try {
        await tx.skillSource.update({
          data: { lastError: null, ...after },
          // The sha the admin diffed must still be the latest, and the source still enabled.
          where: { id: source.id, latestSha: input.sha, status: { not: 'DISABLED' } },
        });
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'P2025') {
          throw new SkillUpdateRefusal('SOURCE_CHANGED');
        }
        throw err;
      }
      const summary: AcceptSummary = {
        accepted,
        added: plan.added.map((s) => safeDisplayPath(s.folder)),
        after,
        before: { pinnedSha: source.pinnedSha, status: source.status },
        conflicts: plan.changed
          .filter((c) => c.handEdited && !chosen.includes(c))
          .map((c) => c.installed.name),
        notSelected: plan.changed
          .filter((c) => !c.handEdited && !chosen.includes(c))
          .map((c) => c.installed.name),
        pinAdvanced,
        removed: plan.removed.map((r) => r.name),
        renamed: [...plan.changed, ...plan.unchanged].flatMap((c) =>
          c.renamedTo === null ? [] : [{ name: c.installed.name, renamedTo: c.renamedTo }]
        ),
        sha: input.sha,
        unreadable: plan.errors.map((e) => e.installed.name),
      };
      await audit(tx, summary);
      return summary;
    },
    { maxWait: 10_000, timeout: 60_000 }
  );
}
