import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_SCANNER_PATTERNS, scannerPatternOrigin } from '../scannerPatterns/index.js';
import { BUILTIN_SKILLS } from '../skills/index.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';

/** Provenance tag for all SWE seed content. */
const SWE_ORIGIN = 'swe-starter';

/**
 * Upserts all built-in reference data — split by provenance so a future
 * deployment can run the platform without the SWE use case:
 *
 *   - {@link seedCoreDefaults} — domain-agnostic platform defaults that always
 *     seed and survive a "core-only" deployment (the cross-cutting scanner
 *     patterns: injection / exfiltration / shell-command / sensitive-file).
 *     These rows carry `origin = null`.
 *   - {@link seedSweStarter} — the SWE use case as seed content: workflow
 *     templates, coding skills + their agent assignments, the implementer tool
 *     config, and the SWE-specific code-security scanner patterns. Every row is
 *     tagged `origin = 'swe-starter'` so it is distinguishable and removable.
 *
 * Behavior is identical to before — everything is still seeded — it is just
 * grouped and provenance-tagged. Safe to call on every startup (findFirst +
 * conditional create/update; scanner patterns upsert by the `label` unique index).
 */
export async function syncBuiltins(prisma: PrismaClient): Promise<void> {
  await seedCoreDefaults(prisma);
  await seedSweStarter(prisma);
}

/** Core platform defaults (origin=null). Always seeded. */
export async function seedCoreDefaults(prisma: PrismaClient): Promise<void> {
  await syncScannerPatterns(prisma, 'core');
}

/** SWE starter content (origin='swe-starter'). Opt-out-able in the future. */
export async function seedSweStarter(prisma: PrismaClient): Promise<void> {
  await syncTemplates(prisma);
  await syncSkills(prisma);
  await syncScannerPatterns(prisma, 'swe');
  await syncImplementerToolConfig(prisma);
  await syncAgents(prisma);
}

/**
 * P1 Agent library: the SWE agent keys as first-class GLOBAL Agent rows.
 *
 * These are seeded as identity-only overlays — every override column is null
 * (no modelSpec / systemPrompt / toolKeys / skillRefs) — so `resolveAgent`
 * falls through to the legacy ModelRoleConfig / AgentSkillAssignment /
 * AgentToolConfig cascade and resolution is byte-identical to P0. The rows give
 * the Agent library something to list and the versioning/override paths
 * (WS3/WS4) somewhere to attach.
 */
const SWE_AGENTS: ReadonlyArray<{ key: string; name: string; description: string }> = [
  {
    description: 'Writes code in the workspace via the TDD loop.',
    key: 'implementer',
    name: 'Implementer',
  },
  {
    description: 'Reviews diffs through the multi-agent review network.',
    key: 'reviewer',
    name: 'Reviewer',
  },
  { description: 'Decomposes work into an implementation plan.', key: 'planner', name: 'Planner' },
  {
    description: 'Legacy security-review role (review network is canonical).',
    key: 'securityReview',
    name: 'Security Review',
  },
  {
    description: 'Extracts success criteria from the work request.',
    key: 'validateContext',
    name: 'Context Validator',
  },
  {
    description: 'Commits lessons to semantic memory.',
    key: 'commitToMemory',
    name: 'Memory Committer',
  },
  {
    description: 'Security-focused sub-reviewer in the review network.',
    key: 'securityReviewer',
    name: 'Security Reviewer',
  },
  {
    description: 'Domain-logic sub-reviewer in the review network.',
    key: 'domainLogicReviewer',
    name: 'Domain Logic Reviewer',
  },
  {
    description: 'Performance-focused sub-reviewer in the review network.',
    key: 'performanceReviewer',
    name: 'Performance Reviewer',
  },
  { description: 'Breaks an epic into subtasks.', key: 'decomposer', name: 'Decomposer' },
];

async function syncAgents(prisma: PrismaClient): Promise<void> {
  for (const def of SWE_AGENTS) {
    const existing = await prisma.agent.findFirst({
      where: { key: def.key, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
    });
    if (!existing) {
      await prisma.agent.create({
        data: {
          description: def.description,
          isBuiltIn: true,
          isVerified: true,
          key: def.key,
          name: def.name,
          origin: SWE_ORIGIN,
          scope: 'GLOBAL',
          version: 1,
        },
      });
    }
  }
}

async function syncTemplates(prisma: PrismaClient): Promise<void> {
  for (const tmpl of BUILTIN_TEMPLATES) {
    const existing = await prisma.workflowTemplate.findFirst({
      where: { name: tmpl.name, teamId: null },
    });
    const t = existing
      ? await prisma.workflowTemplate.update({
          data: {
            activeVersion: 1,
            isDefault: tmpl.isDefault ?? false,
            origin: SWE_ORIGIN,
            status: 'ACTIVE',
          },
          where: { id: existing.id },
        })
      : await prisma.workflowTemplate.create({
          data: {
            activeVersion: 1,
            description: tmpl.description,
            isDefault: tmpl.isDefault ?? false,
            name: tmpl.name,
            origin: SWE_ORIGIN,
            status: 'ACTIVE',
            teamId: null,
          },
        });
    await prisma.workflowTemplateVersion.upsert({
      create: { spec: tmpl.spec as unknown as object, templateId: t.id, version: 1 },
      update: { spec: tmpl.spec as unknown as object },
      where: { templateId_version: { templateId: t.id, version: 1 } },
    });
  }
}

async function syncSkills(prisma: PrismaClient): Promise<void> {
  for (const skillDef of BUILTIN_SKILLS) {
    const existingSkill = await prisma.skill.findFirst({
      where: { isBuiltIn: true, name: skillDef.name },
    });
    const skill = existingSkill
      ? await prisma.skill.update({
          // isActive is intentionally omitted — preserve any admin disable decision.
          data: {
            description: skillDef.description,
            isVerified: true,
            origin: SWE_ORIGIN,
            promptText: skillDef.promptText,
          },
          where: { id: existingSkill.id },
        })
      : await prisma.skill.create({
          data: {
            description: skillDef.description,
            isActive: true,
            isBuiltIn: true,
            isVerified: true,
            name: skillDef.name,
            origin: SWE_ORIGIN,
            promptText: skillDef.promptText,
          },
        });

    for (const assignment of skillDef.assignments) {
      const existingAssignment = await prisma.agentSkillAssignment.findFirst({
        where: {
          agentRole: assignment.role,
          scope: 'GLOBAL',
          skillId: skill.id,
          teamId: null,
          workflowTemplateId: null,
        },
      });
      if (!existingAssignment) {
        await prisma.agentSkillAssignment.create({
          data: {
            agentRole: assignment.role,
            origin: SWE_ORIGIN,
            scope: 'GLOBAL',
            skillId: skill.id,
            sortOrder: assignment.sortOrder,
          },
        });
      }
    }
  }
}

/**
 * Seeds the subset of built-in scanner patterns belonging to `group`:
 *   - 'core' → patterns whose origin is null (cross-cutting categories)
 *   - 'swe'  → patterns tagged 'swe-starter' (CODE_SECURITY)
 * Provenance is derived from the pattern type via `scannerPatternOrigin`.
 */
async function syncScannerPatterns(prisma: PrismaClient, group: 'core' | 'swe'): Promise<void> {
  const wantOrigin = group === 'core' ? null : SWE_ORIGIN;
  for (const p of BUILTIN_SCANNER_PATTERNS) {
    const origin = scannerPatternOrigin(p.type);
    if (origin !== wantOrigin) {
      continue;
    }
    await prisma.scannerPattern.upsert({
      create: {
        flags: p.flags,
        isActive: true,
        isBuiltIn: true,
        label: p.label,
        origin,
        pattern: p.pattern,
        type: p.type,
      },
      update: { flags: p.flags, isActive: true, origin, pattern: p.pattern, type: p.type },
      where: { label: p.label },
    });
  }
}

async function syncImplementerToolConfig(prisma: PrismaClient): Promise<void> {
  const existing = await prisma.agentToolConfig.findFirst({
    where: { agentRole: 'implementer', scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
  });
  if (!existing) {
    await prisma.agentToolConfig.create({
      data: {
        agentRole: 'implementer',
        enabledTools: ['readFile', 'writeFile', 'listDirectory', 'bash'],
        origin: SWE_ORIGIN,
        scope: 'GLOBAL',
      },
    });
  }
}
