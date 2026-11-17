import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import {
  type ProfileFile,
  type ProfileManifest,
  ProfileManifestSchema,
  unpackAndVerify,
} from '@auto-swe/shared/lib/harnessProfile';
import { ApplicationFailure, activityInfo, asyncLocalStorage } from '@temporalio/activity';
import { profilePluginNames } from '../../agents/claudeCode/pluginFiles.js';
import type { McpTracer } from '../../agents/mcpTools.js';
import { type ResolvedAgent, resolveAgent } from './agentResolver.js';
import { bindingNeedsEnablement, enabledProfileIds, enablementTeamId } from './pluginEnablement.js';
import type { ResolveCtx } from './types.js';

/** An agent's bound profile, verified against the hash it was approved under. */
export interface ResolvedHarnessProfile {
  name: string;
  version: number;
  commitSha: string;
  contentHash: string;
  manifest: ProfileManifest;
  files: ProfileFile[];
  /**
   * The platform ADMIN's hook switch (`HarnessProfile.hooksEnabled`) as read when the
   * profile was resolved. It is applied when the plugin is written into the container
   * (`filesToMaterialize`), never to the stored snapshot. Absent reads as on.
   */
  hooksEnabled: boolean;
}

/** What {@link resolveHarnessProfiles} needs from the caller's resolution of the agent. */
export type ProfileBinding = Pick<ResolvedAgent, 'harnessProfiles' | 'scope' | 'teamId'>;

/**
 * The approved harness profiles (plugins) `agentKey` runs with, in binding order;
 * empty when its resolved version is bound to none.
 *
 * Which profiles come from the resolved Agent version itself (`Agent.harnessProfiles`);
 * they are not inherited along `inheritsModelFrom`. Which VERSION of each, in order:
 *  1. a caller-supplied pin (`ctx.harnessProfileVersions`), never written back;
 *  2. the run's pin (`WorkflowRun.harnessProfileVersions`), taken at run start for
 *     every bound agent (`snapshotHarnessProfileVersions`) and otherwise at first
 *     use by a compare-and-set that never overwrites an entry;
 *  3. the profile's latest version, which must be OK.
 * A pinned version keeps working after the profile is disabled, a newer version
 * is approved or the team's enablement is removed: the run was given those
 * instructions and plugins, and a retry or a sibling activity must get the same ones.
 *
 * FAILS CLOSED. A bound profile that is missing, disabled and not pinned, not enabled
 * for the run's team (an agent version that is not platform-wide needs a
 * `PluginEnablement` row for each plugin), whose version row is gone, or whose
 * snapshot no longer reproduces its content hash raises a non-retryable failure; it
 * never resolves to "no profile", which would run the agent without the instructions
 * and plugins an admin bound to it. So do two bound plugins that share a
 * `plugin.json` name (the gateway refuses that at bind time).
 */
export async function resolveHarnessProfiles(
  agentKey: string,
  ctx: ResolveCtx | undefined,
  resolved?: ProfileBinding
): Promise<ResolvedHarnessProfile[]> {
  // The caller's own resolution when it has one: resolving again could land on
  // a version cut in between and pair one version's model with the next one's profile.
  const binding = resolved ?? (await resolveAgent(agentKey, ctx));
  const out: ResolvedHarnessProfile[] = [];
  for (const name of binding.harnessProfiles) {
    out.push(await resolveOne(agentKey, ctx, binding, name));
  }
  assertNoCollision(agentKey, out);
  return out;
}

async function resolveOne(
  agentKey: string,
  ctx: ResolveCtx | undefined,
  binding: ProfileBinding,
  name: string
): Promise<ResolvedHarnessProfile> {
  const profile = await prisma.harnessProfile.findUnique({
    select: { hooksEnabled: true, id: true, latestVersion: true, status: true },
    where: { name },
  });
  if (!profile) {
    throw unavailable(agentKey, name, 'no such profile exists');
  }

  const workflowId = ambientWorkflowId();
  const supplied = ctx?.harnessProfileVersions?.[name];
  let version = supplied ?? (workflowId ? await readPin(workflowId, name) : undefined);
  if (version === undefined) {
    if (profile.status !== 'OK') {
      throw unavailable(agentKey, name, 'it is disabled and this run has not pinned a version');
    }
    if (bindingNeedsEnablement(binding.scope)) {
      const teamId = enablementTeamId(ctx, binding);
      if (!teamId || !(await enabledProfileIds([profile.id], teamId)).has(profile.id)) {
        throw ApplicationFailure.nonRetryable(
          `Agent '${agentKey}' is bound to plugin '${name}', which is not enabled for this run's team. The agent is not run without its plugin.`,
          'PLUGIN_NOT_ENABLED'
        );
      }
    }
    version = profile.latestVersion;
    if (workflowId) {
      // A concurrent resolution pinned first: its answer is the run's.
      version = await pinHarnessProfileVersion(workflowId, name, version);
    }
  }

  const row = await prisma.harnessProfileVersion.findUnique({
    select: { commitSha: true, contentHash: true, files: true, manifest: true },
    where: { profileId_version: { profileId: profile.id, version } },
  });
  if (!row) {
    throw unavailable(agentKey, name, `version ${version} does not exist`);
  }
  const manifest = ProfileManifestSchema.safeParse(row.manifest);
  if (!manifest.success) {
    throw integrity(agentKey, name, version, 'its stored manifest is malformed');
  }
  let files: ProfileFile[];
  try {
    files = unpackAndVerify(row.files, manifest.data, row.contentHash);
  } catch {
    throw integrity(agentKey, name, version, 'its snapshot does not match its content hash');
  }
  return {
    commitSha: row.commitSha,
    contentHash: row.contentHash,
    files,
    hooksEnabled: profile.hooksEnabled,
    manifest: manifest.data,
    name,
    version,
  };
}

function assertNoCollision(agentKey: string, profiles: readonly ResolvedHarnessProfile[]): void {
  const owner = new Map<string, string>();
  for (const profile of profiles) {
    for (const plugin of profilePluginNames(profile)) {
      const key = plugin.toLowerCase();
      const other = owner.get(key);
      if (other !== undefined) {
        throw ApplicationFailure.nonRetryable(
          `Agent '${agentKey}' is bound to plugins '${other}' and '${profile.name}' that both declare the plugin name '${plugin}'. The agent is not run with colliding plugins.`,
          'PLUGIN_NAME_COLLISION'
        );
      }
      owner.set(key, profile.name);
    }
  }
}

/**
 * The profiles a run of `agentKey` on `runtime` is given, for a caller about to
 * build that runtime.
 *
 * `claude-code` is the one runtime that loads a profile: there the profiles are
 * resolved (failing closed, see {@link resolveHarnessProfiles}) and returned for
 * the runtime's options. On any other runtime (Mastra, Pi, or a surface with
 * no workspace) a bound profile is NOT an error: the run proceeds without it
 * and an `agent.profile_not_applicable` event says so, beside an
 * `agent.plugin_partial` event naming what the runtime skipped of each plugin
 * (commands, hooks and sub-agents apply only on `claude-code`; the plugins'
 * skills reach such a run as projected skills). `ranOn` names the loop that
 * actually ran when it is not `runtime`.
 */
export async function resolveProfileForRuntime(args: {
  agentKey: string;
  ctx: ResolveCtx | undefined;
  /** The runtime the Agent resolved to. */
  runtime: string;
  /** True when a Claude Code runtime is built for this run (it has a workspace). */
  appliesToRun?: boolean;
  ranOn?: string;
  /** The caller's resolution of `agentKey`, so the profiles come from the same Agent version as its model. */
  resolved?: ProfileBinding;
  tracer: Pick<McpTracer, 'addActivityEvent'>;
}): Promise<ResolvedHarnessProfile[] | undefined> {
  const { agentKey, ctx, ranOn, resolved, runtime, tracer } = args;
  if (runtime === 'claude-code' && args.appliesToRun !== false) {
    const profiles = await resolveHarnessProfiles(agentKey, ctx, resolved);
    return profiles.length > 0 ? profiles : undefined;
  }
  const { harnessProfiles } = resolved ?? (await resolveAgent(agentKey, ctx));
  if (harnessProfiles.length > 0) {
    const ran = ranOn ?? runtime;
    tracer.addActivityEvent({
      name: 'agent.profile_not_applicable',
      outputJson: {
        agentKey,
        profile: harnessProfiles[0],
        profiles: harnessProfiles,
        ranOn: ran,
        runtime,
      },
    });
    tracer.addActivityEvent({
      name: 'agent.plugin_partial',
      outputJson: {
        agentKey,
        profiles: harnessProfiles,
        ranOn: ran,
        runtime,
        skipped: ['commands', 'hooks', 'sub-agents'],
      },
    });
  }
  return undefined;
}

function unavailable(agentKey: string, name: string, why: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(
    `Agent '${agentKey}' is bound to harness profile '${name}', which is unavailable: ${why}. The agent is not run without its profile.`,
    'PROFILE_UNAVAILABLE'
  );
}

function integrity(
  agentKey: string,
  name: string,
  version: number,
  why: string
): ApplicationFailure {
  return ApplicationFailure.nonRetryable(
    `Harness profile '${name}' version ${version} (agent '${agentKey}') failed its integrity check: ${why}. The agent is not run with a snapshot that differs from the approved one.`,
    'PROFILE_INTEGRITY'
  );
}

/** The workflow id of the activity this runs in, or undefined outside one. */
function ambientWorkflowId(): string | undefined {
  if (!asyncLocalStorage.getStore()) {
    return undefined;
  }
  return activityInfo().workflowExecution?.workflowId;
}

function asPinMap(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asVersion(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The run's pinned version of profile `name`, or undefined when it has none yet. */
async function readPin(workflowId: string, name: string): Promise<number | undefined> {
  const row = await prisma.workflowRun.findUnique({
    select: { harnessProfileVersions: true },
    where: { workflowId },
  });
  return asVersion(asPinMap(row?.harnessProfileVersions)?.[name]);
}

/**
 * Pin `candidate` as the run's version of profile `name` unless one is already
 * pinned, and return the pinned version. A compare-and-set on the whole map, so
 * two activities pinning different profiles at once cannot drop each other's
 * entry and two pinning the same one agree on the first. A pin is never
 * overwritten. A workflow with no run row has nothing to pin and keeps the candidate.
 */
export async function pinHarnessProfileVersion(
  workflowId: string,
  name: string,
  candidate: number
): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await prisma.workflowRun.findUnique({
      select: { harnessProfileVersions: true, id: true },
      where: { workflowId },
    });
    if (!row) {
      return candidate;
    }
    const current = asPinMap(row.harnessProfileVersions);
    const existing = asVersion(current?.[name]);
    if (existing !== undefined) {
      return existing;
    }
    const { count } = await prisma.workflowRun.updateMany({
      data: {
        harnessProfileVersions: { ...current, [name]: candidate } as Prisma.InputJsonObject,
      },
      where: {
        harnessProfileVersions: current
          ? { equals: current as Prisma.InputJsonObject }
          : { equals: Prisma.DbNull },
        id: row.id,
      },
    });
    if (count > 0) {
      return candidate;
    }
  }
  // Retryable: the map kept changing underneath; the next attempt reads it afresh.
  throw new Error(`could not pin harness profile '${name}' on run ${workflowId}`);
}
