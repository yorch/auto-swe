import { z } from 'zod';
import { shortName } from '../projections.js';
import type { ToolKit } from '../toolKit.js';
import type { McpDomain } from './index.js';

/**
 * Teams: who is on them and which repositories they own or are shared with. Team and repository
 * names are authored by people and are clipped and cleaned; descriptions, persona prompts and
 * every member's email are never returned (a member is a user id and a team role).
 */

const teamName = shortName(200);
const teamSlug = shortName(100);
const teamRole = z.enum(['ADMIN', 'LEAD', 'ENGINEER']).catch('ENGINEER');

const repositoryRef = z.object({
  id: z.string().uuid(),
  isActive: z.boolean(),
  organizationName: shortName(200).nullable(),
  repoName: shortName(200).nullable(),
});

const restTeams = z.object({
  data: z.array(
    z.object({
      _count: z.object({ memberships: z.number().int(), repositories: z.number().int() }),
      id: z.string().uuid(),
      name: teamName,
      slug: teamSlug,
    })
  ),
});

const restTeam = z.object({
  data: z.object({
    id: z.string().uuid(),
    memberships: z.array(z.object({ role: teamRole, user: z.object({ id: z.string().uuid() }) })),
    name: teamName,
    repositories: z.array(repositoryRef),
    sharedRepositories: z.array(
      repositoryRef.extend({
        team: z.object({ id: z.string().uuid(), name: teamName, slug: teamSlug }).nullable(),
      })
    ),
    slug: teamSlug,
  }),
});

/** The output side of {@link repositoryRef}: plain types, since a JSON Schema cannot hold a transform. */
const repositoryOut = z.object({
  id: z.string().uuid(),
  isActive: z.boolean(),
  organizationName: z.string().nullable(),
  repoName: z.string().nullable(),
});

const teamsOutput = z.object({
  teams: z.array(
    z.object({
      id: z.string().uuid(),
      memberCount: z.number().int(),
      name: z.string(),
      repositoryCount: z.number().int(),
      slug: z.string(),
    })
  ),
});

const teamOutput = z.object({
  id: z.string().uuid(),
  members: z.array(
    z.object({ role: z.enum(['ADMIN', 'LEAD', 'ENGINEER']), userId: z.string().uuid() })
  ),
  name: z.string(),
  repositories: z.array(repositoryOut),
  sharedRepositories: z.array(
    repositoryOut.extend({
      owningTeam: z
        .object({ id: z.string().uuid(), name: z.string(), slug: z.string() })
        .nullable(),
    })
  ),
  slug: z.string(),
});

export const teamsDomain: McpDomain = {
  name: 'teams',
  register({ get, readTool }: ToolKit) {
    readTool(
      'list_teams',
      {
        description:
          'List the teams you belong to (every active team for an administrator): id, name, slug and how many members and repositories each has. No descriptions or member identities; use get_team for one team.',
        input: {},
        output: teamsOutput,
        title: 'List teams',
      },
      () => get('/api/v1/teams'),
      (body) => {
        const parsed = restTeams.safeParse(body);
        return parsed.success
          ? {
              teams: parsed.data.data.map((t) => ({
                id: t.id,
                memberCount: t._count.memberships,
                name: t.name,
                repositoryCount: t._count.repositories,
                slug: t.slug,
              })),
            }
          : null;
      }
    );

    readTool(
      'get_team',
      {
        description:
          'Get one team you may see: its members as user ids with their team role (no names or emails), the repositories it owns, and the repositories other teams have shared with it. A team you are not a member of is refused, as in the dashboard.',
        input: { teamId: z.string().uuid().describe('The team id, from list_teams') },
        notFound: 'Team not found.',
        output: teamOutput,
        title: 'Get a team',
      },
      (args) => get(`/api/v1/teams/${args.teamId}`),
      (body) => {
        const parsed = restTeam.safeParse(body);
        if (!parsed.success) {
          return null;
        }
        const t = parsed.data.data;
        return {
          id: t.id,
          members: t.memberships.map((m) => ({ role: m.role, userId: m.user.id })),
          name: t.name,
          repositories: t.repositories,
          sharedRepositories: t.sharedRepositories.map(({ team, ...r }) => ({
            ...r,
            owningTeam: team,
          })),
          slug: t.slug,
        };
      }
    );
  },
  tools: [
    { name: 'list_teams', route: 'GET /api/v1/teams', tier: 'user' },
    { name: 'get_team', route: 'GET /api/v1/teams/:id', tier: 'user' },
  ],
};
