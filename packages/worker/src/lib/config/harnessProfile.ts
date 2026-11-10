import { Prisma } from '@auto-swe/shared';
import { prisma } from '@auto-swe/shared/db';
import {
  type ProfileFile,
  type ProfileManifest,
  ProfileManifestSchema,
  unpackAndVerify,
} from '@auto-swe/shared/lib/harnessProfile';
import { ApplicationFailure, activityInfo, asyncLocalStorage } from '@temporalio/activity';
import type { McpTracer } from '../../agents/mcpTools.js';
import { type ResolvedAgent, resolveAgent } from './agentResolver.js';
import type { ResolveCtx } from './types.js';

/** An agent's bound profile, verified against the hash it was approved under. */
export interface ResolvedHarnessProfile {
  name: string;
  version: number;
  commitSha: string;
  contentHash: string;
  manifest: ProfileManifest;
  files: ProfileFile[];
}

/**
 * The approved harness profile `agentKey` runs with, or null when its resolved
 * version is bound to none.
 *
 * Which profile comes from the resolved Agent version itself (`Agent.harnessProfile`);
 * it is not inherited along `inheritsModelFrom`. Which VERSION of it, in order:
 *  1. a caller-supplied pin (`ctx.harnessProfileVersions`), never written back;
 *  2. the run's pin (`WorkflowRun.harnessProfileVersions`), taken at run start for
 *     every bound agent (`snapshotHarnessProfileVersions`) and otherwise at first
 *     use by a compare-and-set that never overwrites an entry;
 *  3. the profile's latest version, which must be OK.
 * A pinned version keeps working after the profile is disabled or a newer version
 * is approved: the run was given those instructions and plugins, and a retry or a
 * sibling activity must get the same ones.
 *
 * FAILS CLOSED. A bound profile that is missing, disabled and not pinned, whose
 * version row is gone, or whose snapshot no longer reproduces its content hash
 * raises a non-retryable failure; it never resolves to "no profile", which would
 * run the agent without the instructions and plugins an admin bound to it.
 */
export async function resolveHarnessProfile(
  agentKey: string,
  ctx: ResolveCtx | undefined,
  resolved?: Pick<ResolvedAgent, 'harnessProfile'>
): Promise<ResolvedHarnessProfile | null> {
  // The caller's own resolution when it has one: resolving again could land on
  // a version cut in between and pair one version's model with the next one's profile.
  const { harnessProfile: name } = resolved ?? (await resolveAgent(agentKey, ctx));
  if (!name) {
    return null;
  }
  const profile = await prisma.harnessProfile.findUnique({
    select: { id: true, latestVersion: true, status: true },
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
    manifest: manifest.data,
    name,
    version,
  };
}

/**
 * The profile a run of `agentKey` on `runtime` is given, for a caller about to
 * build that runtime.
 *
 * `claude-code` is the one runtime that loads a profile: there the profile is
 * resolved (failing closed, see {@link resolveHarnessProfile}) and returned for
 * the runtime's options. On any other runtime (Mastra, Pi, or a surface with
 * no workspace) a bound profile is NOT an error: the run proceeds without it
 * and an `agent.profile_not_applicable` event says so. `ranOn` names the loop
 * that actually ran when it is not `runtime`.
 */
export async function resolveProfileForRuntime(args: {
  agentKey: string;
  ctx: ResolveCtx | undefined;
  /** The runtime the Agent resolved to. */
  runtime: string;
  /** True when a Claude Code runtime is built for this run (it has a workspace). */
  appliesToRun?: boolean;
  ranOn?: string;
  /** The caller's resolution of `agentKey`, so the profile comes from the same Agent version as its model. */
  resolved?: Pick<ResolvedAgent, 'harnessProfile'>;
  tracer: Pick<McpTracer, 'addActivityEvent'>;
}): Promise<ResolvedHarnessProfile | undefined> {
  const { agentKey, ctx, ranOn, resolved, runtime, tracer } = args;
  if (runtime === 'claude-code' && args.appliesToRun !== false) {
    return (await resolveHarnessProfile(agentKey, ctx, resolved)) ?? undefined;
  }
  const { harnessProfile: profile } = resolved ?? (await resolveAgent(agentKey, ctx));
  if (profile) {
    tracer.addActivityEvent({
      name: 'agent.profile_not_applicable',
      outputJson: { agentKey, profile, ranOn: ranOn ?? runtime, runtime },
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
