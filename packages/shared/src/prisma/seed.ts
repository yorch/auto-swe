import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  }),
});

async function main() {
  // Seed admin user
  const admin = await prisma.user.upsert({
    where: { email: 'admin@auto-swe.local' },
    update: {},
    create: {
      email: 'admin@auto-swe.local',
      passwordHash: await bcrypt.hash('admin', 12),
      role: 'ADMIN',
    },
  });
  console.log(`Seed: admin user created (${admin.id})`);

  // Seed default team
  const team = await prisma.team.upsert({
    where: { slug: 'default' },
    update: {},
    create: {
      name: 'Default Team',
      slug: 'default',
      description: 'Default team for local development',
    },
  });
  console.log(`Seed: default team created (${team.id})`);

  // Add admin to default team as ADMIN
  await prisma.teamMembership.upsert({
    where: { userId_teamId: { userId: admin.id, teamId: team.id } },
    update: {},
    create: {
      userId: admin.id,
      teamId: team.id,
      role: 'ADMIN',
    },
  });
  console.log(`Seed: admin added to default team`);

  // Seed a sample repository for local development.
  const repo = await prisma.repository.upsert({
    where: {
      organizationName_repoName: {
        organizationName: 'your-org',
        repoName: 'your-repo',
      },
    },
    update: {},
    create: {
      organizationName: 'your-org',
      repoName: 'your-repo',
      defaultBranch: 'main',
      teamId: team.id,
    },
  });
  console.log(`Seed: sample repository created (${repo.id})`);
  console.log('');
  console.log('  To submit a work request, use this repo ID:');
  console.log(`    curl -X POST http://localhost:8080/api/v1/work-requests \\`);
  console.log(`      -H 'Content-Type: application/json' \\`);
  console.log(`      -d '{"externalTicketId":"JIRA-1","description":"Add health endpoint","repoIds":["${repo.id}"]}'`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
