import type { PrismaClient } from '@auto-swe/shared';
import {
  BUNDLE_SCHEMA_VERSION,
  type BundleAgent,
  type BundleDependency,
  type BundleEntities,
  type BundleManifest,
  type BundleScannerPattern,
  type BundleSkill,
  type BundleTemplate,
  computeContentHash,
  parseBundle,
} from '@auto-swe/shared/bundle';

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

export interface InstallResult {
  counts: { agents: number; skills: number; scannerPatterns: number; templates: number };
  warnings: string[];
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

  const skillRows = await prisma.skill.findMany({
    orderBy: { name: 'asc' },
    where: { isActive: true, ...originWhere },
  });
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
    include: { versions: true },
    orderBy: { name: 'asc' },
    where: { teamId: null, ...originWhere },
  });
  const templates: BundleTemplate[] = [];
  for (const t of templateRows) {
    const active =
      t.versions.find((v) => v.version === (t.activeVersion ?? 1)) ??
      [...t.versions].sort((a, b) => b.version - a.version)[0];
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
  const dependencies = deriveDependencies(entities);
  return {
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    dependencies,
    entities,
    metadata: {
      contentHash: computeContentHash({ dependencies, entities }),
      createdAt: new Date().toISOString(),
      name: opts.name,
      source: opts.origin,
      version: opts.version,
    },
  };
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
export async function installBundle(prisma: PrismaClient, raw: unknown): Promise<InstallResult> {
  const manifest = parseBundle(raw); // throws ZodError on malformed input

  const recomputed = computeContentHash({
    dependencies: manifest.dependencies,
    entities: manifest.entities,
  });
  if (recomputed !== manifest.metadata.contentHash) {
    throw new BundleIntegrityError(
      `bundle content hash mismatch (declared ${manifest.metadata.contentHash}, computed ${recomputed})`
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

  const origin = manifest.metadata.source ?? `bundle:${manifest.metadata.name}`;
  const counts = { agents: 0, scannerPatterns: 0, skills: 0, templates: 0 };

  // Skills first — agents reference them by name.
  for (const s of manifest.entities.skills) {
    const existing = await prisma.skill.findFirst({ where: { name: s.name } });
    if (existing) {
      await prisma.skill.update({
        data: { description: s.description ?? null, origin, promptText: s.promptText },
        where: { id: existing.id },
      });
    } else {
      await prisma.skill.create({
        data: {
          description: s.description ?? null,
          isBuiltIn: true,
          isVerified: s.isVerified ?? false,
          name: s.name,
          origin,
          promptText: s.promptText,
        },
      });
    }
    counts.skills++;
  }

  for (const p of manifest.entities.scannerPatterns) {
    await prisma.scannerPattern.upsert({
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
      toolKeys: a.toolKeys ?? undefined,
    };
    const existing = await prisma.agent.findFirst({
      where: { key: a.key, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
    });
    const agent = existing
      ? await prisma.agent.update({ data: base, where: { id: existing.id } })
      : await prisma.agent.create({
          data: {
            ...base,
            isBuiltIn: true,
            isVerified: a.isVerified ?? false,
            key: a.key,
            scope: 'GLOBAL',
            version: 1,
          },
        });
    // Reconcile skill refs from the bundle (clear + recreate by skill name).
    await prisma.agentSkillRef.deleteMany({ where: { agentId: agent.id } });
    for (const ref of a.skills ?? []) {
      const skill = await prisma.skill.findFirst({ where: { name: ref.skill } });
      if (skill) {
        await prisma.agentSkillRef.create({
          data: { agentId: agent.id, skillId: skill.id, sortOrder: ref.sortOrder ?? 0 },
        });
      }
    }
    counts.agents++;
  }

  for (const t of manifest.entities.templates) {
    const existing = await prisma.workflowTemplate.findFirst({
      where: { name: t.name, teamId: null },
    });
    const tpl = existing
      ? await prisma.workflowTemplate.update({
          data: {
            activeVersion: 1,
            ...(t.inputSchema ? { inputSchema: t.inputSchema as object } : {}),
            origin,
            status: 'ACTIVE',
          },
          where: { id: existing.id },
        })
      : await prisma.workflowTemplate.create({
          data: {
            activeVersion: 1,
            description: t.description ?? '',
            ...(t.inputSchema ? { inputSchema: t.inputSchema as object } : {}),
            name: t.name,
            origin,
            status: 'ACTIVE',
            teamId: null,
          },
        });
    await prisma.workflowTemplateVersion.upsert({
      create: { spec: t.spec as object, templateId: tpl.id, version: 1 },
      update: { spec: t.spec as object },
      where: { templateId_version: { templateId: tpl.id, version: 1 } },
    });
    counts.templates++;
  }

  return { counts, warnings: [] };
}
