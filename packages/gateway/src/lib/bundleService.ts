import { Prisma, type PrismaClient } from '@auto-swe/shared';
import {
  type BundleAgent,
  type BundleDependency,
  type BundleEntities,
  type BundleManifest,
  type BundleScannerPattern,
  BundleSchemaVersionError,
  type BundleSkill,
  type BundleTemplate,
  buildBundleManifest,
  parseBundle,
  type TrustedKey,
  validateBundleScannerPatterns,
  validateBundleTemplates,
  verifyBundleSignature,
  verifyContentHash,
} from '@auto-swe/shared/bundle';
import { runUnscoped } from '@auto-swe/shared/lib/tenantGuard';

/**
 * Bundle export/install service (P4/WS1+WS2). A bundle is a versioned, secret-free
 * export of GLOBAL library content (Agents, Skills, scanner patterns, Templates).
 * Install seeds it as a **managed base layer** (idempotent — same coherence model
 * as `syncBuiltins`); per-team / per-template user overrides via the P1 cascade
 * sit on top and are never touched. Connection *instances* never travel in a
 * bundle — content only declares the connection *types* it needs (`dependencies`).
 */

/** Connection/connector types the platform supports at the code level. */
const SUPPORTED_CONNECTION_TYPES = new Set(['git_repo', 'mcp']);

export class BundleIntegrityError extends Error {}
export class BundleDependencyError extends Error {}

/** The deployment-owned rows an install names, by entity kind. */
export interface ProtectedConflicts {
  agents: string[];
  skills: string[];
  scannerPatterns: string[];
  templates: string[];
}

function emptyConflicts(): ProtectedConflicts {
  return { agents: [], scannerPatterns: [], skills: [], templates: [] };
}

function hasConflicts(c: ProtectedConflicts): boolean {
  return c.agents.length + c.skills.length + c.scannerPatterns.length + c.templates.length > 0;
}

/**
 * The bundle would overwrite GLOBAL content the deployment itself owns — a
 * seeded built-in (`origin = 'swe-starter'` or a core `null`-origin row) or
 * one an admin authored (`origin = null`): an agent by key, a skill by name, a
 * scanner pattern by label, a GLOBAL workflow template by name. Refused unless
 * the install passes `overwriteProtected`.
 *
 * Skills and scanner patterns are protected for the same reason agents are. A
 * skill's `promptText` is injected into every agent that references it, and a
 * built-in `SHELL_COMMAND` pattern is a blocking rule — a bundle that could
 * rewrite `curl … | sh` detection to a regex that never matches would have
 * switched off a control by shipping content.
 */
export class BundleProtectedContentError extends Error {
  readonly conflicts: ProtectedConflicts;
  /** The refused bundle's manifest name, for the audit record. */
  readonly bundleName: string;
  constructor(conflicts: ProtectedConflicts, bundleName: string) {
    const parts = [
      conflicts.agents.length > 0 ? `agent(s) ${conflicts.agents.join(', ')}` : null,
      conflicts.skills.length > 0 ? `skill(s) ${conflicts.skills.join(', ')}` : null,
      conflicts.scannerPatterns.length > 0
        ? `scanner pattern(s) ${conflicts.scannerPatterns.join(', ')}`
        : null,
      conflicts.templates.length > 0 ? `template(s) ${conflicts.templates.join(', ')}` : null,
    ].filter((x): x is string => x !== null);
    super(
      `bundle would overwrite protected GLOBAL content: ${parts.join('; ')}. ` +
        'These are platform built-ins or admin-authored; rename the bundle entries ' +
        '(e.g. a namespaced key such as "my-bundle.reviewer") or reinstall with ' +
        'overwriteProtected to replace them deliberately.'
    );
    this.conflicts = conflicts;
    this.bundleName = bundleName;
  }
}

/** Origin of the SWE starter content seeded by `syncBuiltins`. */
const SWE_STARTER_ORIGIN = 'swe-starter';

/**
 * Whether a GLOBAL row belongs to the deployment rather than to a bundle.
 * Bundles tag everything they write with a non-null origin other than the
 * starter's, so only those rows are a bundle's to replace.
 */
function isDeploymentOwned(origin: string | null): boolean {
  return origin === null || origin === SWE_STARTER_ORIGIN;
}

type InstallTx = Prisma.TransactionClient;

/**
 * Every deployment-owned row the manifest would overwrite.
 *
 * Read inside the install transaction, immediately before the writes, so the
 * decision is taken on the rows the writes then act on rather than on a
 * snapshot from before the transaction opened — a `syncBuiltins` that seeds a
 * built-in between the two would otherwise be overwritten unchecked.
 */
async function findProtectedConflicts(
  tx: InstallTx,
  manifest: BundleManifest
): Promise<ProtectedConflicts> {
  const conflicts = emptyConflicts();
  for (const a of manifest.entities.agents) {
    const head = await tx.agent.findFirst({
      orderBy: { version: 'desc' },
      select: { origin: true },
      where: { key: a.key, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
    });
    if (head && isDeploymentOwned(head.origin)) {
      conflicts.agents.push(a.key);
    }
  }
  for (const sk of manifest.entities.skills) {
    const row = await tx.skill.findFirst({
      select: { origin: true },
      where: { name: sk.name, scope: 'GLOBAL' },
    });
    if (row && isDeploymentOwned(row.origin)) {
      conflicts.skills.push(sk.name);
    }
  }
  for (const pat of manifest.entities.scannerPatterns) {
    const row = await tx.scannerPattern.findUnique({
      select: { origin: true },
      where: { label: pat.label },
    });
    if (row && isDeploymentOwned(row.origin)) {
      conflicts.scannerPatterns.push(pat.label);
    }
  }
  for (const tpl of manifest.entities.templates) {
    const row = await tx.workflowTemplate.findFirst({
      select: { origin: true },
      where: { name: tpl.name, teamId: null },
    });
    if (row && isDeploymentOwned(row.origin)) {
      conflicts.templates.push(tpl.name);
    }
  }
  return conflicts;
}

/** Key-sorted JSON, so two specs that differ only in key order compare equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        )
      : v
  );
}

/**
 * Install one GLOBAL workflow template without rewriting history or an
 * admin's choices — the same rules `syncBuiltins` follows for built-ins.
 *
 * - **Missing** → create it at v1, ACTIVE, owned by this bundle. Never the
 *   global default: `isDefault` is not a bundle's to set.
 * - **Present** → no existing version is rewritten. A run pins its template
 *   version, so rewriting v1 in place changed the graph under every run that
 *   had pinned it. A changed spec is appended as a NEW version.
 * - **Activation** → the new version becomes active only while the template is
 *   still ACTIVE on the version the previous install wrote (the newest version
 *   with no author: every version a user or the author agent saves carries
 *   one). An admin who promoted their own version, or archived the template,
 *   keeps that choice; the new version waits in the history for them.
 * - `isDefault` and `status` are never written on an existing template.
 */
async function installBundleTemplate(
  tx: InstallTx,
  t: BundleManifest['entities']['templates'][number],
  origin: string
): Promise<void> {
  const spec = t.spec as object;
  const inputSchema = t.inputSchema ? { inputSchema: t.inputSchema as object } : {};
  const existing = await tx.workflowTemplate.findFirst({
    select: { activeVersion: true, id: true, status: true },
    where: { name: t.name, teamId: null },
  });
  if (!existing) {
    await tx.workflowTemplate.create({
      data: {
        activeVersion: 1,
        description: t.description ?? '',
        ...inputSchema,
        name: t.name,
        origin,
        status: 'ACTIVE',
        teamId: null,
        versions: { create: { spec, version: 1 } },
      },
    });
    return;
  }

  const versions = await tx.workflowTemplateVersion.findMany({
    orderBy: { version: 'asc' },
    select: { createdBy: true, generatedBy: true, spec: true, version: true },
    where: { templateId: existing.id },
  });
  const previous = versions.filter((v) => v.createdBy == null && v.generatedBy == null).at(-1);
  if (previous && canonicalJson(previous.spec) === canonicalJson(spec)) {
    return; // Re-install of the same content: nothing to append or activate.
  }

  const next = (versions.at(-1)?.version ?? 0) + 1;
  await tx.workflowTemplateVersion.create({
    data: { spec, templateId: existing.id, version: next },
  });

  const onPrevious =
    previous !== undefined &&
    existing.status === 'ACTIVE' &&
    existing.activeVersion === previous.version;
  if (onPrevious) {
    // Conditional on the row still pointing where it was read.
    await tx.workflowTemplate.updateMany({
      data: { activeVersion: next, ...inputSchema, origin },
      where: { activeVersion: previous.version, id: existing.id, teamId: null },
    });
  }
}

export interface InstallResult {
  counts: { agents: number; skills: number; scannerPatterns: number; templates: number };
  /**
   * Deployment-owned rows this install replaced. Empty unless the install
   * passed `overwriteProtected`; recorded in the audit row so a forced install
   * says what it overwrote, not only that it was allowed to.
   */
  replacedProtected: ProtectedConflicts;
  /** The `InstalledBundle` registry row this install wrote — the audit entity. */
  installedBundleId: string;
  /** VERIFIED when the bundle's signature matched a trusted key, else UNVERIFIED. */
  trustState: 'VERIFIED' | 'UNVERIFIED';
  signedBy: string | null;
  warnings: string[];
}

export interface InstallOptions {
  /** Deployment trust anchors; a signature matching one yields trustState=VERIFIED. */
  trustedKeys?: TrustedKey[];
  installedById?: string | null;
  /** Permit an UNVERIFIED bundle to install; defaults to false (deny by default). */
  allowUnverified?: boolean;
  /**
   * Permit the bundle to overwrite protected GLOBAL content — a seeded built-in
   * or admin-authored agent, skill or scanner pattern. Defaults to false: a
   * bundle agent keyed `reviewer` must not silently replace the platform's
   * reviewer, nor a pattern labelled like a built-in neuter its rule.
   */
  overwriteProtected?: boolean;
}

export interface InstalledBundleRow {
  name: string;
  version: string;
  source: string | null;
  trustState: string;
  signedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Installed-bundle registry (P4/WS3), most-recent first. */
export async function listInstalledBundles(prisma: PrismaClient): Promise<InstalledBundleRow[]> {
  return prisma.installedBundle.findMany({
    orderBy: { updatedAt: 'desc' },
    select: {
      createdAt: true,
      name: true,
      signedBy: true,
      source: true,
      trustState: true,
      updatedAt: true,
      version: true,
    },
  });
}

function toStringArray(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
}

/** The connection types the bundle's content requires (derived, conservative). */
function deriveDependencies(entities: BundleEntities): BundleDependency[] {
  const types = new Set<string>();
  for (const a of entities.agents) {
    if (a.toolKeys?.includes('mcp')) {
      types.add('mcp');
    }
  }
  for (const t of entities.templates) {
    const nodes = (t.spec as { nodes?: Record<string, { type?: string }> } | null)?.nodes ?? {};
    for (const node of Object.values(nodes)) {
      if (node?.type === 'mcp') {
        types.add('mcp');
      }
    }
  }
  return [...types].sort().map((connectionType) => ({ connectionType }));
}

/**
 * Serialize a tagged set of GLOBAL library entities into a {@link BundleManifest}.
 * `origin` selects the set (e.g. 'swe-starter'); omit to export all GLOBAL content.
 * Deployment-local fields (ids, team/credential/mcp bindings, versions, timestamps)
 * are stripped; only the active version of each Agent/Template is exported.
 */
export async function exportBundle(
  prisma: PrismaClient,
  opts: { name: string; version: string; origin?: string }
): Promise<BundleManifest> {
  const originWhere = opts.origin !== undefined ? { origin: opts.origin } : {};

  const agentRows = await prisma.agent.findMany({
    include: {
      skillRefs: {
        include: { skill: { select: { name: true } } },
        orderBy: { sortOrder: 'asc' },
      },
    },
    orderBy: [{ key: 'asc' }, { version: 'desc' }],
    where: {
      isActive: true,
      scope: 'GLOBAL',
      teamId: null,
      workflowTemplateId: null,
      ...originWhere,
    },
  });
  const seenAgentKeys = new Set<string>();
  const agents: BundleAgent[] = [];
  for (const a of agentRows) {
    if (seenAgentKeys.has(a.key)) {
      continue; // keep only the highest active version per key
    }
    seenAgentKeys.add(a.key);
    agents.push({
      description: a.description,
      inheritsModelFrom: a.inheritsModelFrom,
      isVerified: a.isVerified,
      key: a.key,
      modelSpec: a.modelSpec,
      name: a.name,
      origin: a.origin,
      skills: a.skillRefs.map((r) => ({ skill: r.skill.name, sortOrder: r.sortOrder })),
      systemPrompt: a.systemPrompt,
      toolKeys: toStringArray(a.toolKeys),
    });
  }

  // Bundle export is an admin operation and selects by `origin`, not tenant.
  const skillRows = await runUnscoped(
    'bundle export selects by origin, not tenant',
    ['Skill'],
    () =>
      prisma.skill.findMany({ orderBy: { name: 'asc' }, where: { isActive: true, ...originWhere } })
  );
  const skills: BundleSkill[] = skillRows.map((s) => ({
    description: s.description,
    isVerified: s.isVerified,
    name: s.name,
    origin: s.origin,
    promptText: s.promptText,
  }));

  const patternRows = await prisma.scannerPattern.findMany({
    orderBy: { label: 'asc' },
    where: { isActive: true, ...originWhere },
  });
  const scannerPatterns: BundleScannerPattern[] = patternRows.map((p) => ({
    flags: p.flags,
    label: p.label,
    origin: p.origin,
    pattern: p.pattern,
    type: p.type,
  }));

  const templateRows = await prisma.workflowTemplate.findMany({
    orderBy: { name: 'asc' },
    where: { teamId: null, ...originWhere },
  });
  const templates: BundleTemplate[] = [];
  for (const t of templateRows) {
    // Fetch only the active version's spec (pinned if set, else the highest) —
    // not the whole version history.
    const active = await prisma.workflowTemplateVersion.findFirst({
      orderBy: { version: 'desc' },
      where: { templateId: t.id, ...(t.activeVersion != null ? { version: t.activeVersion } : {}) },
    });
    if (!active) {
      continue;
    }
    templates.push({
      description: t.description,
      inputSchema: t.inputSchema ?? null,
      name: t.name,
      origin: t.origin,
      spec: active.spec,
    });
  }

  const entities: BundleEntities = { agents, scannerPatterns, skills, templates };
  // Assembly + hashing live in `@auto-swe/shared/bundle` (`buildBundleManifest`)
  // so this and the SDK's `defineBundle` cannot drift over what the v2 hash
  // covers — identity included.
  return buildBundleManifest({
    dependencies: deriveDependencies(entities),
    entities,
    name: opts.name,
    version: opts.version,
    ...(opts.origin !== undefined ? { source: opts.origin } : {}),
  });
}

/**
 * Install a bundle as a GLOBAL managed base layer (idempotent; re-install = upgrade).
 * Validates the schema + content hash and the dependency manifest *before* any
 * write, then seeds skills → scanner patterns → agents (+ skill refs) → templates,
 * each tagged with the bundle's provenance. Throws {@link BundleIntegrityError} /
 * {@link BundleDependencyError} non-destructively (before writes).
 *
 * Note: agents are updated in place at GLOBAL scope (the managed base layer is
 * authoritative for its own fields), mirroring `syncBuiltins`; user overrides live
 * at TEAM/TEMPLATE scope and are untouched.
 */
export async function installBundle(
  prisma: PrismaClient,
  raw: unknown,
  opts: InstallOptions = {}
): Promise<InstallResult> {
  let manifest: BundleManifest;
  try {
    manifest = parseBundle(raw); // throws ZodError on malformed input
  } catch (err) {
    // A bundle built under an older trust format (v1 signed only entities +
    // dependencies, leaving name/version unsigned) is rejected outright rather
    // than reinterpreted — surfaced as a 400 with the re-sign instructions.
    if (err instanceof BundleSchemaVersionError) {
      throw new BundleIntegrityError(err.message);
    }
    throw err;
  }

  // Covers the manifest's identity (name/version) as well as its content, so a
  // relabelled copy of a signed bundle fails here before trust is evaluated.
  const hash = verifyContentHash(manifest);
  if (!hash.ok) {
    throw new BundleIntegrityError(
      `bundle content hash mismatch (declared ${manifest.metadata.contentHash}, computed ${hash.expected})`
    );
  }

  // Scanner patterns are executable content: apply the same ReDoS/compile gate
  // the admin API applies, BEFORE any write and regardless of trust state — an
  // UNVERIFIED bundle is installable, so this is the only thing standing between
  // a bundle-supplied `(a+)+$` and the worker's scan loop.
  const patternErrors = validateBundleScannerPatterns(manifest);
  if (patternErrors.length > 0) {
    throw new BundleIntegrityError(
      `bundle contains unsafe scanner pattern(s):\n  - ${patternErrors.join('\n  - ')}`
    );
  }

  // Templates install as ACTIVE, so a spec that cannot run — no reachable
  // `terminate`, an expression that does not parse — must be refused here
  // rather than by the first run that loads it. Same advisory/error split as
  // the template save path: only `errors` block.
  const templateErrors = validateBundleTemplates(manifest);
  if (templateErrors.length > 0) {
    throw new BundleIntegrityError(
      `bundle contains unrunnable workflow template(s):\n  - ${templateErrors.join('\n  - ')}`
    );
  }

  const unsupported = manifest.dependencies
    .map((d) => d.connectionType)
    .filter((t) => !SUPPORTED_CONNECTION_TYPES.has(t));
  if (unsupported.length > 0) {
    throw new BundleDependencyError(
      `bundle requires unsupported connection type(s): ${unsupported.join(', ')}`
    );
  }

  // Trust: a detached signature matching a deployment-trusted key → VERIFIED.
  const trust = verifyBundleSignature(manifest, opts.trustedKeys ?? []);
  const trustState = trust.verified ? 'VERIFIED' : 'UNVERIFIED';

  if (trustState === 'UNVERIFIED' && !opts.allowUnverified) {
    throw new BundleIntegrityError(
      'bundle is UNVERIFIED and unverified installs are disabled. ' +
        'Add the signer to BUNDLE_TRUSTED_KEYS or set BUNDLE_ALLOW_UNVERIFIED=1 to proceed.'
    );
  }

  const origin = manifest.metadata.source ?? `bundle:${manifest.metadata.name}`;
  const counts = { agents: 0, scannerPatterns: 0, skills: 0, templates: 0 };
  let replacedProtected = emptyConflicts();
  let installedBundleId = '';

  // Atomic: seed all entities + record the registry row in one transaction, so a
  // mid-install failure rolls back rather than leaving a half-applied base layer.
  // Generous timeout — a large bundle is many sequential writes.
  await prisma.$transaction(
    async (tx) => {
      // First, and inside the transaction: a refusal throws before any write
      // (and would roll one back regardless), naming every conflict at once.
      const conflicts = await findProtectedConflicts(tx, manifest);
      if (hasConflicts(conflicts)) {
        if (!opts.overwriteProtected) {
          throw new BundleProtectedContentError(conflicts, manifest.metadata.name);
        }
        replacedProtected = conflicts;
      }

      // Skills first — agents reference them by name.
      for (const s of manifest.entities.skills) {
        // Skill names are only unique per scope: a TEAM/ORG custom skill with the
        // same name must not be overwritten and rebranded as the managed GLOBAL layer.
        const existing = await tx.skill.findFirst({ where: { name: s.name, scope: 'GLOBAL' } });
        if (existing) {
          await tx.skill.update({
            data: {
              description: s.description ?? null,
              // Never trust the bundle's verification flag — installing new content
              // over an existing skill must reset isVerified, matching the create
              // branch below; otherwise an UNVERIFIED bundle can silently overwrite a
              // human-verified skill's prompt while it keeps its verified badge.
              isVerified: false,
              origin,
              promptText: s.promptText,
            },
            where: { id: existing.id },
          });
        } else {
          await tx.skill.create({
            data: {
              description: s.description ?? null,
              isBuiltIn: true,
              // Never trust the bundle's verification flag — installed content starts
              // UNVERIFIED; verification is a local human step regardless of trust state.
              isVerified: false,
              name: s.name,
              origin,
              promptText: s.promptText,
            },
          });
        }
        counts.skills++;
      }

      for (const p of manifest.entities.scannerPatterns) {
        await tx.scannerPattern.upsert({
          create: {
            flags: p.flags ?? '',
            isBuiltIn: true,
            label: p.label,
            origin,
            pattern: p.pattern,
            type: p.type,
          },
          update: { flags: p.flags ?? '', origin, pattern: p.pattern, type: p.type },
          where: { label: p.label },
        });
        counts.scannerPatterns++;
      }

      for (const a of manifest.entities.agents) {
        const base = {
          description: a.description ?? null,
          inheritsModelFrom: a.inheritsModelFrom ?? null,
          modelSpec: a.modelSpec ?? null,
          name: a.name,
          origin,
          systemPrompt: a.systemPrompt ?? null,
          // DbNull (not undefined) so a re-install clears a stale toolKeys override
          // rather than leaving the prior value on the managed base-layer row.
          toolKeys: a.toolKeys ?? Prisma.DbNull,
        };
        // GLOBAL agents are versioned and the resolver reads the highest version,
        // so a re-install must update the lineage head — not whichever version
        // Postgres happens to return first.
        const existing = await tx.agent.findFirst({
          orderBy: { version: 'desc' },
          where: { key: a.key, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
        });
        const agent = existing
          ? await tx.agent.update({ data: base, where: { id: existing.id } })
          : await tx.agent.create({
              data: {
                ...base,
                isBuiltIn: true,
                // Bundle's verification flag is not trusted (see skills above).
                isVerified: false,
                key: a.key,
                scope: 'GLOBAL',
                version: 1,
              },
            });
        // Reconcile skill refs from the bundle (clear + recreate by skill name).
        await tx.agentSkillRef.deleteMany({ where: { agentId: agent.id } });
        for (const ref of a.skills ?? []) {
          const skill = await tx.skill.findFirst({ where: { name: ref.skill, scope: 'GLOBAL' } });
          if (skill) {
            await tx.agentSkillRef.create({
              data: { agentId: agent.id, skillId: skill.id, sortOrder: ref.sortOrder ?? 0 },
            });
          }
        }
        counts.agents++;
      }

      for (const t of manifest.entities.templates) {
        await installBundleTemplate(tx, t, origin);
        counts.templates++;
      }

      // Record the install in the registry inside the same transaction (one row
      // per bundle name) — a rolled-back install leaves no registry row.
      const registryRow = await tx.installedBundle.upsert({
        create: {
          contentHash: manifest.metadata.contentHash,
          installedById: opts.installedById ?? null,
          name: manifest.metadata.name,
          signedBy: trust.signedBy,
          source: manifest.metadata.source ?? null,
          trustState,
          version: manifest.metadata.version,
        },
        update: {
          contentHash: manifest.metadata.contentHash,
          installedById: opts.installedById ?? null,
          signedBy: trust.signedBy,
          source: manifest.metadata.source ?? null,
          trustState,
          version: manifest.metadata.version,
        },
        where: { name: manifest.metadata.name },
      });
      installedBundleId = registryRow.id;
    },
    { maxWait: 10_000, timeout: 120_000 }
  );

  return {
    counts,
    installedBundleId,
    replacedProtected,
    signedBy: trust.signedBy,
    trustState,
    warnings: [],
  };
}
