import { z } from 'zod';
import { shortName, timestamp } from '../projections.js';
import { query, type ToolKit } from '../toolKit.js';
import type { McpDomain } from './index.js';

/**
 * The agent and skill library: which agents exist, how their versions line up, and which skills
 * they use. Prompts, instructions, descriptions, tool configuration, credential and MCP connection
 * ids, author emails, skill text and scan warning text are all free text or internal references
 * and are never returned. What is left is identifiers, flags, version numbers, model specs,
 * timestamps and the short names an admin gives an agent or a skill.
 */

const SCOPES = ['GLOBAL', 'ORGANIZATION', 'TEAM', 'CHANNEL', 'WORKFLOW_TEMPLATE'] as const;
const scope = z.enum([...SCOPES, 'unknown']).catch('unknown');
const version = z.number().int().positive();
const modelSpec = shortName(200).nullable().optional().default(null);
const USED_BY_CAP = 50;

const owner = z.string().uuid().nullable().optional().default(null);

const restAgents = z.object({
  data: z.array(
    z.object({
      channelId: owner,
      createdAt: timestamp,
      id: z.string().uuid(),
      isActive: z.boolean(),
      isVerified: z.boolean(),
      key: shortName(130),
      modelSpec,
      name: shortName(200),
      orgId: owner,
      scope,
      teamId: owner,
      updatedAt: timestamp.optional().default(''),
      version,
      workflowTemplateId: owner,
    })
  ),
});

const restVersions = z.object({
  data: z.array(
    z.object({
      createdAt: timestamp,
      createdById: z.string().uuid().nullable().optional().default(null),
      id: z.string().uuid(),
      isActive: z.boolean(),
      isVerified: z.boolean(),
      modelSpec,
      version,
    })
  ),
});

const restSkills = z.object({
  data: z.array(
    z.object({
      currentRevision: z.number().int().positive(),
      externalSource: z
        .object({ host: shortName(200), owner: shortName(100), repo: shortName(100) })
        .nullable()
        .optional()
        .default(null),
      id: z.string().uuid(),
      isActive: z.boolean().optional(),
      isBuiltIn: z.boolean(),
      isVerified: z.boolean(),
      name: shortName(200),
      scanWarnings: z.array(z.unknown()).optional().default([]),
      usedBy: z.array(shortName(130)).optional().default([]),
      usedByCount: z.number().int().min(0),
    })
  ),
});

const agentsOutput = z.object({
  agents: z.array(
    z.object({
      channelId: z.string().uuid().nullable(),
      createdAt: z.string(),
      id: z.string().uuid(),
      isActive: z.boolean(),
      isVerified: z.boolean(),
      key: z.string(),
      modelSpec: z.string().nullable(),
      name: z.string(),
      orgId: z.string().uuid().nullable(),
      scope: z.enum([...SCOPES, 'unknown']),
      teamId: z.string().uuid().nullable(),
      updatedAt: z.string(),
      version: z.number().int(),
      workflowTemplateId: z.string().uuid().nullable(),
    })
  ),
});

const versionsOutput = z.object({
  versions: z.array(
    z.object({
      createdAt: z.string(),
      createdById: z.string().uuid().nullable(),
      id: z.string().uuid(),
      isActive: z.boolean(),
      isVerified: z.boolean(),
      modelSpec: z.string().nullable(),
      version: z.number().int(),
    })
  ),
});

const skillsOutput = z.object({
  skills: z.array(
    z.object({
      currentRevision: z.number().int(),
      externalSource: z
        .object({ host: z.string(), owner: z.string(), repo: z.string() })
        .nullable(),
      id: z.string().uuid(),
      isActive: z.boolean().nullable(),
      isBuiltIn: z.boolean(),
      isVerified: z.boolean(),
      name: z.string(),
      scanWarningCount: z.number().int(),
      usedBy: z.array(z.string()),
      usedByCount: z.number().int(),
    })
  ),
});

export const libraryDomain: McpDomain = {
  name: 'library',
  register({ get, readTool }: ToolKit) {
    readTool(
      'list_agent_library',
      {
        description:
          'List the agents in the library (latest version of each, or every version with `all`): id, key, name, scope, version, whether active and verified, and the model. Prompts, descriptions, tools and credentials are not returned.',
        input: {
          all: z.boolean().optional().describe('Every version instead of the latest of each'),
          channelId: z.string().uuid().optional().describe('Only agents of this channel'),
          orgId: z.string().uuid().optional().describe('Only agents of this organization'),
          scope: z.enum(SCOPES).optional().describe('Only agents at this scope'),
          teamId: z.string().uuid().optional().describe('Only agents of this team'),
          workflowTemplateId: z
            .string()
            .uuid()
            .optional()
            .describe('Only agents of this workflow template'),
        },
        output: agentsOutput,
        title: 'List the agent library',
      },
      (args) =>
        get(
          '/api/v1/platform/agent-library',
          query({
            all: args.all === undefined ? undefined : String(args.all),
            channelId: args.channelId,
            orgId: args.orgId,
            scope: args.scope,
            teamId: args.teamId,
            workflowTemplateId: args.workflowTemplateId,
          })
        ),
      (body) => {
        const parsed = restAgents.safeParse(body);
        return parsed.success
          ? {
              agents: parsed.data.data.map((a) => ({
                channelId: a.channelId,
                createdAt: a.createdAt,
                id: a.id,
                isActive: a.isActive,
                isVerified: a.isVerified,
                key: a.key,
                modelSpec: a.modelSpec,
                name: a.name,
                orgId: a.orgId,
                scope: a.scope,
                teamId: a.teamId,
                updatedAt: a.updatedAt,
                version: a.version,
                workflowTemplateId: a.workflowTemplateId,
              })),
            }
          : null;
      }
    );

    readTool(
      'list_agent_versions',
      {
        description:
          'List every version of one agent lineage, newest first: id, version number, whether active and verified, the model, who created it (user id) and when. Prompts and other version content are not returned.',
        input: { agentId: z.string().uuid().describe('The id of any version of the agent') },
        notFound: 'Agent not found.',
        output: versionsOutput,
        title: 'List an agent’s versions',
      },
      (args) => get(`/api/v1/platform/agent-library/${args.agentId}/versions`),
      (body) => {
        const parsed = restVersions.safeParse(body);
        return parsed.success
          ? {
              versions: parsed.data.data.map((v) => ({
                createdAt: v.createdAt,
                createdById: v.createdById,
                id: v.id,
                isActive: v.isActive,
                isVerified: v.isVerified,
                modelSpec: v.modelSpec,
                version: v.version,
              })),
            }
          : null;
      }
    );

    readTool(
      'list_skills',
      {
        description:
          'List the skills in the library: name, whether built-in, verified and active, current revision, how many agent version rows reference it (usedByCount, inactive versions included) and the distinct keys of the active agents that do (usedBy, at most 50), how many scan warnings the current revision has, and the external source host, owner and repository. Skill text, descriptions and warning text are not returned.',
        input: {},
        output: skillsOutput,
        title: 'List skills',
      },
      () => get('/api/v1/platform/skills'),
      (body) => {
        const parsed = restSkills.safeParse(body);
        return parsed.success
          ? {
              skills: parsed.data.data.map((s) => ({
                currentRevision: s.currentRevision,
                externalSource: s.externalSource,
                id: s.id,
                isActive: s.isActive ?? null,
                isBuiltIn: s.isBuiltIn,
                isVerified: s.isVerified,
                name: s.name,
                scanWarningCount: s.scanWarnings.length,
                usedBy: s.usedBy.slice(0, USED_BY_CAP),
                usedByCount: s.usedByCount,
              })),
            }
          : null;
      }
    );
  },
  tools: [
    {
      aliasRoutes: ['GET /api/v1/admin/agent-library'],
      name: 'list_agent_library',
      route: 'GET /api/v1/platform/agent-library',
      tier: 'admin',
    },
    {
      name: 'list_agent_versions',
      route: 'GET /api/v1/platform/agent-library/:id/versions',
      tier: 'admin',
    },
    {
      aliasRoutes: ['GET /api/v1/admin/skills'],
      name: 'list_skills',
      route: 'GET /api/v1/platform/skills',
      tier: 'admin',
    },
  ],
};
