import type { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_SCANNER_PATTERNS } from '../scannerPatterns/index.js';
import { BUILTIN_SKILLS } from '../skills/index.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';

/**
 * Upserts all built-in reference data — workflow templates, skills, scanner
 * patterns, and the default implementer tool config — so every environment
 * automatically receives new or updated built-ins on gateway startup without a
 * manual `yarn db:seed` step.
 *
 * Safe to call on every startup: templates and skills use findFirst + conditional
 * create/update (Postgres NULL != NULL prevents standard upsert on nullable unique
 * keys); scanner patterns upsert by the `label` unique index; tool config is
 * created only when absent.
 */
export async function syncBuiltins(prisma: PrismaClient): Promise<void> {
  await syncTemplates(prisma);
  await syncSkills(prisma);
  await syncScannerPatterns(prisma);
  await syncImplementerToolConfig(prisma);
}

async function syncTemplates(prisma: PrismaClient): Promise<void> {
  for (const tmpl of BUILTIN_TEMPLATES) {
    const existing = await prisma.workflowTemplate.findFirst({
      where: { name: tmpl.name, teamId: null },
    });
    const t = existing
      ? await prisma.workflowTemplate.update({
          data: { activeVersion: 1, isDefault: tmpl.isDefault ?? false, status: 'ACTIVE' },
          where: { id: existing.id },
        })
      : await prisma.workflowTemplate.create({
          data: {
            activeVersion: 1,
            description: tmpl.description,
            isDefault: tmpl.isDefault ?? false,
            name: tmpl.name,
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
            scope: 'GLOBAL',
            skillId: skill.id,
            sortOrder: assignment.sortOrder,
          },
        });
      }
    }
  }
}

async function syncScannerPatterns(prisma: PrismaClient): Promise<void> {
  for (const p of BUILTIN_SCANNER_PATTERNS) {
    await prisma.scannerPattern.upsert({
      create: {
        flags: p.flags,
        isActive: true,
        isBuiltIn: true,
        label: p.label,
        pattern: p.pattern,
        type: p.type,
      },
      update: { flags: p.flags, isActive: true, pattern: p.pattern, type: p.type },
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
        scope: 'GLOBAL',
      },
    });
  }
}
