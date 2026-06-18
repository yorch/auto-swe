import type { PrismaClient } from '../generated/prisma/client.js';
import {
  CONTEXT_VALIDATOR_PROMPT,
  DECOMPOSER_AGENT_PROMPT,
  DOMAIN_LOGIC_REVIEWER_PROMPT,
  IMPLEMENTER_SYSTEM_PROMPT,
  MEMORY_SUMMARIZER_PROMPT,
  PERFORMANCE_REVIEWER_PROMPT,
  PLANNER_AGENT_PROMPT,
  SECURITY_AUDITOR_PROMPT,
  SECURITY_REVIEW_PROMPT,
} from './agentPrompts.js';
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
 *     templates, coding skills, the first-class Agents (model/skills/tools) +
 *     their skillRefs, and the SWE-specific code-security scanner patterns.
 *     Every row is tagged `origin = 'swe-starter'` so it is distinguishable
 *     and removable.
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
  await syncAgents(prisma);
}

/**
 * The SWE agent keys as first-class GLOBAL `Agent` rows — the single source of
 * truth for model / skills / tools (P1.5). Model-backed roles carry a default
 * `modelSpec`; sub-roles carry `inheritsModelFrom`; the implementer carries its
 * `toolKeys`. Skill refs are synced from `BUILTIN_SKILLS` assignments. The
 * credential is still resolved by provider from `ProviderCredential` at run
 * time, so a fresh deploy only needs the admin to add a credential.
 */
interface SweAgentDef {
  key: string;
  name: string;
  description: string;
  /** Default `<provider>/<model>` for model-backed roles. */
  modelSpec?: string;
  /** Parent agent key this persona inherits its model from (sub-roles only). */
  inheritsModelFrom?: string;
  /** Tool keys this agent may use (null/omitted = all candidate tools). */
  toolKeys?: string[];
  /** Base system prompt / persona for this agent. */
  systemPrompt: string;
}

const IMPLEMENTER_TOOLS = ['readFile', 'writeFile', 'listDirectory', 'bash'];

const SWE_AGENTS: ReadonlyArray<SweAgentDef> = [
  {
    description: 'Writes code in the workspace via the TDD loop.',
    key: 'implementer',
    modelSpec: 'anthropic/claude-opus-4-8',
    name: 'Implementer',
    systemPrompt: IMPLEMENTER_SYSTEM_PROMPT,
    toolKeys: IMPLEMENTER_TOOLS,
  },
  {
    description: 'Reviews diffs through the multi-agent review network.',
    key: 'reviewer',
    modelSpec: 'anthropic/claude-opus-4-8',
    name: 'Reviewer',
    systemPrompt: DOMAIN_LOGIC_REVIEWER_PROMPT,
  },
  {
    description: 'Decomposes work into an implementation plan.',
    key: 'planner',
    modelSpec: 'anthropic/claude-sonnet-4-6',
    name: 'Planner',
    systemPrompt: PLANNER_AGENT_PROMPT,
  },
  {
    description: 'Legacy security-review role (review network is canonical).',
    key: 'securityReview',
    modelSpec: 'anthropic/claude-sonnet-4-6',
    name: 'Security Review',
    systemPrompt: SECURITY_REVIEW_PROMPT,
  },
  {
    description: 'Extracts success criteria from the work request.',
    key: 'validateContext',
    modelSpec: 'anthropic/claude-sonnet-4-6',
    name: 'Context Validator',
    systemPrompt: CONTEXT_VALIDATOR_PROMPT,
  },
  {
    description: 'Commits lessons to semantic memory.',
    key: 'commitToMemory',
    modelSpec: 'anthropic/claude-opus-4-8',
    name: 'Memory Committer',
    systemPrompt: MEMORY_SUMMARIZER_PROMPT,
  },
  {
    description: 'Security-focused sub-reviewer in the review network.',
    inheritsModelFrom: 'reviewer',
    key: 'securityReviewer',
    name: 'Security Reviewer',
    systemPrompt: SECURITY_AUDITOR_PROMPT,
  },
  {
    description: 'Domain-logic sub-reviewer in the review network.',
    inheritsModelFrom: 'reviewer',
    key: 'domainLogicReviewer',
    name: 'Domain Logic Reviewer',
    systemPrompt: DOMAIN_LOGIC_REVIEWER_PROMPT,
  },
  {
    description: 'Performance-focused sub-reviewer in the review network.',
    inheritsModelFrom: 'reviewer',
    key: 'performanceReviewer',
    name: 'Performance Reviewer',
    systemPrompt: PERFORMANCE_REVIEWER_PROMPT,
  },
  {
    description: 'Breaks an epic into subtasks.',
    inheritsModelFrom: 'planner',
    key: 'decomposer',
    name: 'Decomposer',
    systemPrompt: DECOMPOSER_AGENT_PROMPT,
  },
];

/** Build `agentKey → [{ skillName, sortOrder }]` from the built-in skill assignments. */
function skillsByAgentKey(): Map<string, Array<{ name: string; sortOrder: number }>> {
  const map = new Map<string, Array<{ name: string; sortOrder: number }>>();
  for (const skill of BUILTIN_SKILLS) {
    for (const a of skill.assignments) {
      const list = map.get(a.role) ?? [];
      list.push({ name: skill.name, sortOrder: a.sortOrder });
      map.set(a.role, list);
    }
  }
  return map;
}

async function syncAgents(prisma: PrismaClient): Promise<void> {
  const skillMap = skillsByAgentKey();
  for (const def of SWE_AGENTS) {
    let agent = await prisma.agent.findFirst({
      where: { key: def.key, scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
    });
    if (!agent) {
      agent = await prisma.agent.create({
        data: {
          description: def.description,
          inheritsModelFrom: def.inheritsModelFrom ?? null,
          isBuiltIn: true,
          isVerified: true,
          key: def.key,
          modelSpec: def.modelSpec ?? null,
          name: def.name,
          origin: SWE_ORIGIN,
          scope: 'GLOBAL',
          systemPrompt: def.systemPrompt,
          toolKeys: def.toolKeys ?? undefined,
          version: 1,
        },
      });
    } else if (!agent.systemPrompt) {
      // One-time migration: backfill systemPrompt for existing rows that predate
      // this change. Skipped once an admin has set a custom value.
      await prisma.agent.update({
        data: { systemPrompt: def.systemPrompt },
        where: { id: agent.id },
      });
    }

    // Sync the agent's skill refs from the built-in assignments (idempotent).
    for (const want of skillMap.get(def.key) ?? []) {
      const skill = await prisma.skill.findFirst({
        where: { isBuiltIn: true, name: want.name },
      });
      if (!skill) {
        continue;
      }
      const existingRef = await prisma.agentSkillRef.findFirst({
        where: { agentId: agent.id, skillId: skill.id },
      });
      if (!existingRef) {
        await prisma.agentSkillRef.create({
          data: { agentId: agent.id, skillId: skill.id, sortOrder: want.sortOrder },
        });
      }
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
            ...(tmpl.inputSchema ? { inputSchema: tmpl.inputSchema as object } : {}),
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
            ...(tmpl.inputSchema ? { inputSchema: tmpl.inputSchema as object } : {}),
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
    if (existingSkill) {
      // isActive is intentionally omitted — preserve any admin disable decision.
      await prisma.skill.update({
        data: {
          description: skillDef.description,
          isVerified: true,
          origin: SWE_ORIGIN,
          promptText: skillDef.promptText,
        },
        where: { id: existingSkill.id },
      });
    } else {
      await prisma.skill.create({
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
    }
    // Skill→agent attachment is via the Agent's skillRefs (synced in syncAgents);
    // the legacy AgentSkillAssignment table was removed in P1.5.
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
