import type { PrismaClient } from '@auto-swe/shared';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';

/** The slug of the organization the seed creates, and the fallback when no default team exists. */
export const SEED_ORGANIZATION_SLUG = 'default';

type TeamReader = Pick<PrismaClient, 'team'>;
type DefaultOrganizationDb = Pick<PrismaClient, 'organization' | 'team'>;

/**
 * The organization that owns the team with this slug, or null when there is no such team.
 *
 * The default team is the one `defaultTeamSlug` (workflow defaults) names, and it is where every
 * new account is enrolled (sign-up, invitation, Slack provisioning), so the organization that
 * holds it is the one that must stay able to take members.
 */
export async function defaultTeamOrganizationId(
  db: TeamReader,
  defaultTeamSlug: string
): Promise<string | null> {
  const team = await db.team.findUnique({
    select: { orgId: true },
    where: { slug: defaultTeamSlug },
  });
  return team?.orgId ?? null;
}

/**
 * The one definition of "the default organization", for every site that needs it: the fallback of
 * `POST /api/v1/teams` when no `orgId` is sent, the refusal to deactivate it, and the check on a
 * saved `defaultTeamSlug`.
 *
 * It is the organization that owns the default team, because that is the key the rest of the
 * platform follows (account enrolment reads `defaultTeamSlug`, never an organization slug). When
 * the team does not exist (a deployment before the seed, or one that removed it) it falls back to
 * the organization with the seed's slug `default`; null when neither exists.
 *
 * Pass `defaultTeamSlug` when the caller already holds the value, or when it must be the one a
 * transaction read under a lock; otherwise it is resolved from the workflow defaults.
 */
export async function resolveDefaultOrganizationId(
  db: DefaultOrganizationDb,
  defaultTeamSlug?: string
): Promise<string | null> {
  const slug = defaultTeamSlug ?? (await resolveWorkflowDefaults()).defaultTeamSlug;
  const owner = await defaultTeamOrganizationId(db, slug);
  if (owner) {
    return owner;
  }
  const seeded = await db.organization.findUnique({
    select: { id: true },
    where: { slug: SEED_ORGANIZATION_SLUG },
  });
  return seeded?.id ?? null;
}
