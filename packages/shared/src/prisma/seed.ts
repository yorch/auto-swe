import crypto from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';
import { PrismaClient } from '../generated/prisma/client.js';
import { DEFAULT_ENGINEERING_SPEC } from '../workflow/defaultEngineeringSpec.js';

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

  // Seed admin user
  const admin = await prisma.user.upsert({
    create: {
      email: 'admin@auto-swe.local',
      passwordHash: await bcrypt.hash(adminPassword, 12),
      role: 'ADMIN',
    },
    update: {},
    where: { email: 'admin@auto-swe.local' },
  });
  console.log(`Seed: admin user created (${admin.id})`);

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

  // Seed the global default engineering workflow template. teamId=null means
  // "global default" — used when a team has no team-scoped default. Postgres
  // unique indexes treat NULL as distinct from NULL, so we look up explicitly
  // by (teamId IS NULL, name) rather than using upsert with the compound key.
  const existingTpl = await prisma.workflowTemplate.findFirst({
    where: { name: 'default-engineering', teamId: null },
  });
  const tpl = existingTpl
    ? await prisma.workflowTemplate.update({
        data: { activeVersion: 1, isDefault: true, status: 'ACTIVE' },
        where: { id: existingTpl.id },
      })
    : await prisma.workflowTemplate.create({
        data: {
          activeVersion: 1,
          description: 'Default engineering workflow (parity with EngineeringWorkflow).',
          isDefault: true,
          name: 'default-engineering',
          status: 'ACTIVE',
          teamId: null,
        },
      });
  await prisma.workflowTemplateVersion.upsert({
    create: {
      createdBy: admin.id,
      spec: DEFAULT_ENGINEERING_SPEC as unknown as object,
      templateId: tpl.id,
      version: 1,
    },
    update: { spec: DEFAULT_ENGINEERING_SPEC as unknown as object },
    where: { templateId_version: { templateId: tpl.id, version: 1 } },
  });
  console.log(`Seed: default workflow template seeded (${tpl.id}@v1)`);
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
