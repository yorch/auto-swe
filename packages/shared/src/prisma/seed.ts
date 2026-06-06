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

  // ── Built-in skills ───────────────────────────────────────────────────────
  // Each skill has a name, description, promptText (injected into system prompts),
  // and one or more role assignments with sortOrders. Postgres NULL != NULL so
  // we use findFirst + conditional create (no upsert) for GLOBAL-scope assignments.

  type BuiltinSkillDef = {
    name: string;
    description: string;
    promptText: string;
    assignments: { role: string; sortOrder: number }[];
  };

  const BUILTIN_SKILLS: BuiltinSkillDef[] = [
    {
      assignments: [
        { role: 'PLANNER', sortOrder: 10 },
        { role: 'VALIDATE_CONTEXT', sortOrder: 10 },
      ],
      description:
        'Prevents scope creep by requiring strict adherence to the stated requirement with no unsolicited additions.',
      name: 'scope-conservatism',
      promptText: `## Scope Conservatism

Implement only what is explicitly requested. Do not add "nice to have" features, refactor unrelated code, or make improvements outside the stated scope, even if they seem obviously beneficial.

If you identify something broken or suboptimal that is adjacent to the work, note it in a code comment or the PR description — do not silently fix it as part of this change.

When in doubt about whether something is in scope, treat it as out of scope.`,
    },
    {
      assignments: [{ role: 'IMPLEMENTER', sortOrder: 10 }],
      description:
        'Requires reading adjacent code before writing, to ensure new code matches established conventions exactly.',
      name: 'follow-existing-patterns',
      promptText: `## Follow Existing Patterns

Before writing any new code, read the files adjacent to your change. Identify:
- Naming conventions (variable names, function names, file names)
- Error handling patterns (try/catch shape, error types thrown)
- Import style (type-only imports, barrel re-exports)
- Code organization (where helpers live, how modules are structured)

Match those patterns exactly. Do not introduce a new pattern when an existing one covers the case, even if you prefer the new one.`,
    },
    {
      assignments: [
        { role: 'IMPLEMENTER', sortOrder: 20 },
        { role: 'PLANNER', sortOrder: 20 },
      ],
      description:
        'Mandates writing or updating tests before or alongside implementation code, with explicit fail-then-pass verification.',
      name: 'test-first',
      promptText: `## Test First

Write or update tests before or alongside the implementation — never after.

- For new behaviour: write the test first (red), then the implementation (green)
- For bug fixes: add a failing test that reproduces the bug before fixing it
- For refactors: confirm existing tests pass before and after the change

Co-locate test files next to the source file they cover (e.g., \`foo.test.ts\` next to \`foo.ts\`). Use \`vitest\` — the project test runner. Do not skip or stub assertions to make tests pass artificially.`,
    },
    {
      assignments: [{ role: 'IMPLEMENTER', sortOrder: 30 }],
      description:
        'Requires one logical change per commit with conventional prefixes, ensuring each commit leaves the codebase in a passing state.',
      name: 'incremental-commits',
      promptText: `## Incremental Commits

Commit one logical change at a time. Each commit must:
1. Leave the codebase in a passing state (tests green, types check, no lint errors)
2. Have a concise message with a conventional prefix: \`feat:\`, \`fix:\`, \`refactor:\`, \`test:\`, \`docs:\`, \`chore:\`
3. Cover only the work described — do not batch unrelated changes

Do not create a single "big bang" commit at the end. Commit incrementally as work progresses.`,
    },
    {
      assignments: [
        { role: 'IMPLEMENTER', sortOrder: 40 },
        { role: 'PLANNER', sortOrder: 30 },
      ],
      description:
        'Requires checking existing dependencies and Node.js built-ins before adding any new packages to the project.',
      name: 'no-new-dependencies',
      promptText: `## No New Dependencies

Before adding any npm/yarn package, check:
1. Whether the project already has a dependency that covers the need (search \`package.json\` files and \`node_modules\`)
2. Whether Node.js built-ins cover the need (\`node:crypto\`, \`node:fs\`, \`node:path\`, etc.)
3. Whether the functionality can be implemented inline with a small, maintainable helper

Only add a new dependency if none of the above apply. When you do add one, explain in the PR description why existing options were insufficient.`,
    },
    {
      assignments: [
        { role: 'IMPLEMENTER', sortOrder: 50 },
        { role: 'SECURITY_REVIEW', sortOrder: 10 },
      ],
      description:
        'Enforces safe shell command construction to prevent injection, path traversal, and privilege escalation.',
      name: 'shell-command-safety',
      promptText: `## Shell Command Safety

When constructing shell commands:
- Never interpolate unvalidated strings directly into command strings
- Always escape user-controlled or agent-generated values before passing them to shell execution
- Use argument arrays (not string concatenation) when the execution API supports it
- Reject or sanitise paths that contain \`..\` or begin with \`/\` when operating within a workspace directory
- Never construct \`sudo\`, \`chmod 777\`, or privilege-escalation commands unless explicitly required and documented
- Prefer reading output to a temp file over piping through untrusted interpreters

If you are unsure whether a value is safe to interpolate, treat it as unsafe.`,
    },
    {
      assignments: [
        { role: 'IMPLEMENTER', sortOrder: 60 },
        { role: 'SECURITY_REVIEW', sortOrder: 20 },
      ],
      description:
        'Injects security best practices for input validation, secrets handling, error messages, and authentication checks.',
      name: 'security-aware-implementation',
      promptText: `## Security-Aware Implementation

Apply these practices on every change:

**Input validation** — validate at system boundaries (HTTP handlers, CLI args, webhook payloads). Reject early with a 400/422 rather than passing raw input deeper.

**Secrets** — never log, return in API responses, or store in plaintext. Use the project's existing encryption envelope (\`CONFIG_ENCRYPTION_KEY\`). Never commit \`.env\` or credentials.

**Error messages** — return generic messages to callers; log full detail server-side with a correlation ID. Do not expose stack traces, SQL, or file paths to clients.

**Auth checks** — new HTTP routes must go through the existing RBAC middleware. Check that the authenticated user has the required role/team membership before accessing data.

**SQL** — use Prisma client for all DB access. Raw SQL (\`$queryRawUnsafe\`) is only permitted for pgvector operations.`,
    },
    {
      assignments: [{ role: 'REVIEWER', sortOrder: 10 }],
      description:
        'Directs reviewers to prioritise security findings above all other issues, with mandatory rejection on CRITICAL severity.',
      name: 'review-focus-security',
      promptText: `## Review Priority: Security First

Evaluate findings in this order of severity:
1. **CRITICAL** — auth bypass, secret exposure, RCE, SQL injection, SSRF → reject immediately; do not approve regardless of other findings
2. **HIGH** — XSS, IDOR, path traversal, missing auth check, plaintext secrets in logs → reject
3. **MEDIUM** — input not validated at boundary, error detail leaked, insecure default → reject unless low-impact context is clear
4. **LOW / INFO** — style, minor inefficiency — note but do not block approval

A single CRITICAL or HIGH finding is sufficient grounds to reject. Document the exact file and line in your rejection reason.`,
    },
    {
      assignments: [{ role: 'REVIEWER', sortOrder: 20 }],
      description:
        'Ensures reviewers verify that all error paths, 4xx/5xx responses, and not-found cases are explicitly handled and tested.',
      name: 'error-path-coverage',
      promptText: `## Error Path Coverage

During review, verify that every error path is explicitly handled:

- **catch blocks** — must not be empty or log-only. Every \`catch\` should either re-throw, transform the error, or take a meaningful recovery action.
- **HTTP endpoints** — every handler must return an appropriate 4xx/5xx for all failure modes (not-found, unauthorised, validation failure, downstream error).
- **Database queries** — \`findFirst\`/\`findUnique\` results must be null-checked before use; missing records should produce a 404, not a 500.
- **Temporal activities** — non-retriable errors must be explicitly thrown as \`ApplicationFailure.nonRetryable()\`; all others should propagate for Temporal to retry.

Flag any path where an error is silently swallowed or where a missing null-check could cause an unhandled exception.`,
    },
    {
      assignments: [{ role: 'COMMIT_TO_MEMORY', sortOrder: 10 }],
      description:
        'Guides the memory agent to produce root-cause-first, transferable lessons with specific fix patterns rather than vague summaries.',
      name: 'actionable-lessons',
      promptText: `## Actionable Lessons

When summarising a completed workflow into a memory lesson:

1. **Root cause first** — state the underlying cause before the symptom (e.g. "Temporal activity timed out because the Docker exec call had no timeout, not because the task was too complex")
2. **Specific fix pattern** — describe the concrete change that would prevent recurrence (e.g. "Add a 30-second timeout to every \`exec()\` call in workspace activities")
3. **Transferable** — phrase the lesson so a future agent working on a different task in the same codebase can apply it without knowing the original context
4. **Avoid vagueness** — do not write lessons like "be more careful" or "test more thoroughly"; name the specific check, guard, or pattern that was missing
5. **One lesson, one root cause** — if multiple independent things went wrong, write separate lessons rather than conflating them into one`,
    },
  ];

  for (const skillDef of BUILTIN_SKILLS) {
    // Create or update the skill record
    const existingSkill = await prisma.skill.findFirst({
      where: { isBuiltIn: true, name: skillDef.name },
    });
    const skill = existingSkill
      ? await prisma.skill.update({
          data: {
            description: skillDef.description,
            promptText: skillDef.promptText,
          },
          where: { id: existingSkill.id },
        })
      : await prisma.skill.create({
          data: {
            description: skillDef.description,
            isBuiltIn: true,
            name: skillDef.name,
            promptText: skillDef.promptText,
          },
        });

    // Create GLOBAL assignments for each role (no upsert — partial unique index)
    for (const assignment of skillDef.assignments) {
      const existingAssignment = await prisma.agentSkillAssignment.findFirst({
        where: {
          agentRole: assignment.role as never,
          scope: 'GLOBAL',
          skillId: skill.id,
          teamId: null,
          workflowTemplateId: null,
        },
      });
      if (!existingAssignment) {
        await prisma.agentSkillAssignment.create({
          data: {
            agentRole: assignment.role as never,
            scope: 'GLOBAL',
            skillId: skill.id,
            sortOrder: assignment.sortOrder,
          },
        });
      }
    }

    console.log(
      `Seed: built-in skill '${skillDef.name}' seeded (${skillDef.assignments.map((a) => a.role).join(', ')})`
    );
  }

  // ── Default IMPLEMENTER tool config ──────────────────────────────────────
  // Ensure the GLOBAL AgentToolConfig for IMPLEMENTER exists with all 4 tools.
  // The partial unique index prevents duplicates; we check existence first since
  // Prisma cannot express WHERE clauses on unique indexes.
  const existingToolConfig = await prisma.agentToolConfig.findFirst({
    where: { agentRole: 'IMPLEMENTER', scope: 'GLOBAL', teamId: null, workflowTemplateId: null },
  });
  if (!existingToolConfig) {
    await prisma.agentToolConfig.create({
      data: {
        agentRole: 'IMPLEMENTER',
        enabledTools: ['readFile', 'writeFile', 'listDirectory', 'bash'],
        scope: 'GLOBAL',
      },
    });
  }
  console.log(
    'Seed: IMPLEMENTER GLOBAL tool config seeded (readFile, writeFile, listDirectory, bash)'
  );
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
