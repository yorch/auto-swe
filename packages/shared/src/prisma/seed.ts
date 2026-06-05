import crypto from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import { PrismaClient } from '../generated/prisma/client.js';
import { BUILTIN_TEMPLATES } from '../workflow/builtinTemplates.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

async function main() {
  // Derive admin password from env or generate a random one on first seed.
  // SEED_ADMIN_PASSWORD is intentionally not printed unless it was generated,
  // so accidental log ingestion doesn't expose a configured secret.
  let adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(16).toString('hex');
    console.log(`Seed: generated admin password: ${adminPassword}`);
    console.log('  Set SEED_ADMIN_PASSWORD in your .env to use a stable password.');
  }

  // Seed admin user. emailVerified is set TRUE so better-auth's
  // account-linking-by-verified-email picks this row up when the same email
  // later signs in via GitHub / Google / magic-link (otherwise a duplicate
  // would be created).
  // SEED_ADMIN_EMAIL must match the default in provisionAuthAdmin.ts, which
  // looks this row up by the same env var.
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@auto-swe.local';
  const admin = await prisma.user.upsert({
    create: {
      email: adminEmail,
      emailVerified: true,
      passwordHash: await bcrypt.hash(adminPassword, 12),
      role: 'ADMIN',
    },
    update: { emailVerified: true },
    where: { email: adminEmail },
  });
  console.log(`Seed: admin user created (${admin.id})`);
  console.log(
    '  Sign in with email+password via the legacy bcrypt path, or use magic link / GitHub / Google.'
  );
  console.log(
    '  Run `yarn db:seed:auth` next to also provision a better-auth credential (enables the new email+password tab on /login).'
  );

  // Seed default team
  const team = await prisma.team.upsert({
    create: {
      description: 'Default team for local development',
      name: 'Default Team',
      slug: 'default',
    },
    update: {},
    where: { slug: 'default' },
  });
  console.log(`Seed: default team created (${team.id})`);

  // Add admin to default team as ADMIN
  await prisma.teamMembership.upsert({
    create: {
      role: 'ADMIN',
      teamId: team.id,
      userId: admin.id,
    },
    update: {},
    where: { userId_teamId: { teamId: team.id, userId: admin.id } },
  });
  console.log(`Seed: admin added to default team`);

  // Seed a sample repository for local development.
  const repo = await prisma.repository.upsert({
    create: {
      defaultBranch: 'main',
      organizationName: 'your-org',
      repoName: 'your-repo',
      teamId: team.id,
    },
    update: {},
    where: {
      organizationName_repoName: {
        organizationName: 'your-org',
        repoName: 'your-repo',
      },
    },
  });
  console.log(`Seed: sample repository created (${repo.id})`);

  // Seed all built-in workflow templates from the unified BUILTIN_TEMPLATES store.
  // Postgres NULL != NULL so we look up by (teamId IS NULL, name) rather than upsert.
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
      create: {
        createdBy: admin.id,
        spec: tmpl.spec as unknown as object,
        templateId: t.id,
        version: 1,
      },
      update: { spec: tmpl.spec as unknown as object },
      where: { templateId_version: { templateId: t.id, version: 1 } },
    });
    console.log(
      `Seed: template '${tmpl.name}' seeded (${t.id}@v1)${tmpl.isDefault ? ' [default]' : ''}`
    );
  }

  console.log('');
  console.log('  To submit a work request, use this repo ID:');
  console.log(`    curl -X POST http://localhost:8080/api/v1/work-requests \\`);
  console.log(`      -H 'Content-Type: application/json' \\`);
  console.log(
    `      -d '{"externalTicketId":"JIRA-1","description":"Add health endpoint","repoIds":["${repo.id}"]}'`
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
