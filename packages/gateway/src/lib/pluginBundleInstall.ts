import type { Prisma, PrismaClient } from '@auto-swe/shared';
import type { BundlePlugin } from '@auto-swe/shared/bundle';
import { lockAgentLineage } from '@auto-swe/shared/lib/agentLineageLock';
import { packFiles, projectPluginSkills, unpackFiles } from '@auto-swe/shared/lib/harnessProfile';
import {
  SKILL_SOURCE_ERRORS,
  SkillSourceError,
  type SkillSourceErrorCode,
  type SourceLocation,
} from '@auto-swe/shared/lib/skillSource';
import {
  HarnessProfileInvalid,
  type ReadProfile,
  readAndCheckProfile,
} from './harnessProfileService.js';
import { pluginNamesOf } from './pluginSnapshot.js';

/**
 * Plugin references in a bundle (schema v3). A bundle never carries a plugin's bytes: install reads
 * the folder at the exact commit with the guarded fetcher, validates and scans it, and requires the
 * profile content hash to equal the bundle's before anything is written. A profile created here is
 * created with hooks OFF (a platform ADMIN switches them on, separately), and every approval
 * warning is returned to the installer, who must acknowledge it.
 */

/** Reads one plugin folder at an exact commit; production uses `readAndCheckProfile`. */
export type PluginReader = (
  location: SourceLocation,
  opts: { atSha: string }
) => Promise<ReadProfile>;

export const defaultPluginReader: PluginReader = (location, opts) =>
  readAndCheckProfile(location, opts);

/** The bundle's content hash for the plugin differs from the folder at the commit. */
export class BundlePluginHashMismatchError extends Error {
  constructor(
    readonly pluginName: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `plugin '${pluginName}': the content at the pinned commit does not match the bundle's contentHash`
    );
    this.name = 'BundlePluginHashMismatchError';
  }
}

/** The folder is not a valid profile, or its name is not the one the bundle gives. */
export class BundlePluginInvalidError extends Error {
  constructor(
    readonly pluginName: string,
    readonly errors: string[]
  ) {
    super(`plugin '${pluginName}' is not a valid harness profile`);
    this.name = 'BundlePluginInvalidError';
  }
}

/** The fetch was refused or failed; `code` is a fixed skill-source error code. */
export class BundlePluginFetchError extends Error {
  constructor(
    readonly pluginName: string,
    readonly code: SkillSourceErrorCode | 'UNKNOWN'
  ) {
    super(
      `plugin '${pluginName}': ${
        code === 'UNKNOWN' ? 'the plugin could not be read' : SKILL_SOURCE_ERRORS[code]
      }`
    );
    this.name = 'BundlePluginFetchError';
  }
}

/** Approval warnings exist for a profile this install would create, and were not acknowledged. */
export class BundlePluginWarningsError extends Error {
  constructor(readonly warnings: string[]) {
    super(
      `the bundle installs plugins that have warnings; review them and acknowledge: ${warnings.join('; ')}`
    );
    this.name = 'BundlePluginWarningsError';
  }
}

/**
 * Binding the bundle's plugins would list a profile twice on an agent, or put two plugins of the
 * same name on one (the harness knows plugins by name). Answered 400 with `code`.
 */
export class BundlePluginCollisionError extends Error {
  constructor(
    readonly code: 'PROFILE_NAME_COLLISION' | 'PROFILE_DUPLICATE',
    message: string
  ) {
    super(message);
    this.name = 'BundlePluginCollisionError';
  }
}

/** A plugin the bundle read at its pinned commit, hash-checked. */
export interface PluginPlan {
  plugin: BundlePlugin;
  read: ReadProfile;
  /** Structure and scanner findings, each naming the plugin. */
  warnings: string[];
}

function locationOf(plugin: BundlePlugin): SourceLocation {
  return {
    host: plugin.source.host ?? 'github.com',
    owner: plugin.source.owner,
    path: plugin.source.path ?? '',
    // The bundle names a commit, not a ref; `HEAD` is the default branch a later update check
    // follows. The read below is pinned to the commit and never resolves it.
    ref: 'HEAD',
    repo: plugin.source.repo,
  };
}

/**
 * Read every plugin the bundle references at its pinned commit and check it. Network I/O, so it
 * runs before any transaction. Throws {@link BundlePluginFetchError},
 * {@link BundlePluginInvalidError} or {@link BundlePluginHashMismatchError}; nothing is stored.
 */
export async function readBundlePlugins(
  plugins: readonly BundlePlugin[],
  read: PluginReader = defaultPluginReader
): Promise<PluginPlan[]> {
  const plans: PluginPlan[] = [];
  for (const plugin of plugins) {
    let result: ReadProfile;
    try {
      result = await read(locationOf(plugin), { atSha: plugin.sha });
    } catch (err) {
      if (err instanceof HarnessProfileInvalid) {
        throw new BundlePluginInvalidError(plugin.name, err.errors);
      }
      if (err instanceof SkillSourceError) {
        throw new BundlePluginFetchError(plugin.name, err.code);
      }
      throw new BundlePluginFetchError(plugin.name, 'UNKNOWN');
    }
    if (result.validated.contentHash !== plugin.contentHash) {
      throw new BundlePluginHashMismatchError(
        plugin.name,
        plugin.contentHash,
        result.validated.contentHash
      );
    }
    if (result.validated.manifest.name !== plugin.name) {
      throw new BundlePluginInvalidError(plugin.name, [
        "the folder's profile.json names a different profile than the bundle does",
      ]);
    }
    plans.push({
      plugin,
      read: result,
      warnings: result.warnings.map((w) => `plugin '${plugin.name}': ${w}`),
    });
  }
  return plans;
}

export type PluginDecision =
  | { action: 'create'; plan: PluginPlan }
  | {
      action: 'reuse';
      plan: PluginPlan;
      profileId: string;
      /** The stored version whose content hash equals the bundle's. */
      version: number;
      /** The profile's latest version: what an agent bound by name actually runs. */
      latestVersion: number;
      disabled: boolean;
    }
  | { action: 'conflict'; plan: PluginPlan };

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * What installing each plugin would do. A profile of the name whose stored versions include the
 * same content hash is reused (its hook switch is never touched); one that does not is a conflict:
 * the bundle cannot replace what an admin approved, whatever `overwriteProtected` says.
 */
export async function decidePlugins(
  db: Db,
  plans: readonly PluginPlan[]
): Promise<PluginDecision[]> {
  const out: PluginDecision[] = [];
  for (const plan of plans) {
    const { name, contentHash } = plan.plugin;
    const rows = await db.harnessProfile.findMany({
      select: { id: true, latestVersion: true, name: true, status: true },
      where: { name: { equals: name, mode: 'insensitive' } },
    });
    if (rows.length === 0) {
      out.push({ action: 'create', plan });
      continue;
    }
    const exact = rows.find((r) => r.name === name);
    const version = exact
      ? await db.harnessProfileVersion.findFirst({
          orderBy: { version: 'desc' },
          select: { version: true },
          where: { contentHash, profileId: exact.id },
        })
      : null;
    if (exact && version) {
      out.push({
        action: 'reuse',
        disabled: exact.status !== 'OK',
        latestVersion: exact.latestVersion,
        plan,
        profileId: exact.id,
        version: version.version,
      });
    } else {
      out.push({ action: 'conflict', plan });
    }
  }
  return out;
}

/** The profile version an agent bound to this plugin runs: always the latest approved one. */
export const boundVersionOf = (d: Exclude<PluginDecision, { action: 'conflict' }>): number =>
  d.action === 'create' ? 1 : d.latestVersion;

/**
 * A reused plugin whose matching version is not the profile's latest: the bundle verified an older
 * snapshot, but binding is by name and so the agent runs the latest approved version. Null otherwise.
 */
export function reuseVersionWarning(d: PluginDecision): string | null {
  if (d.action !== 'reuse' || d.version === d.latestVersion) {
    return null;
  }
  return `plugin '${d.plan.plugin.name}': the profile's latest version (${d.latestVersion}) differs from the referenced version (${d.version}); the agent will use the latest approved version`;
}

/** Names of the plugins whose profile exists with different content. */
export const pluginConflicts = (decisions: readonly PluginDecision[]): string[] =>
  decisions.filter((d) => d.action === 'conflict').map((d) => d.plan.plugin.name);

/** Warnings of the profiles an install would create (a reused profile was approved earlier). */
export const warningsToAcknowledge = (decisions: readonly PluginDecision[]): string[] =>
  decisions.flatMap((d) => (d.action === 'create' ? d.plan.warnings : []));

/**
 * The refusal of decision 10 for a bundle install: why binding these plugins to their agents would
 * leave an agent with a duplicate profile or two plugins of one name, or null. Reads the agents'
 * current GLOBAL heads and each bound profile's latest snapshot afresh; a plugin already bound to
 * an agent is the idempotent re-install and is skipped.
 */
export async function bindingCollision(
  db: Db,
  decisions: readonly PluginDecision[]
): Promise<BundlePluginCollisionError | null> {
  const live = decisions.filter((d) => d.action !== 'conflict');
  const seen = new Set<string>();
  for (const d of live) {
    const { name, bindings } = d.plan.plugin;
    if (seen.has(name)) {
      return new BundlePluginCollisionError(
        'PROFILE_DUPLICATE',
        `plugin '${name}' is listed more than once in the bundle`
      );
    }
    seen.add(name);
    const keys = bindings.map((b) => b.agentKey);
    const again = keys.find((k, i) => keys.indexOf(k) !== i);
    if (again !== undefined) {
      return new BundlePluginCollisionError(
        'PROFILE_DUPLICATE',
        `plugin '${name}' is bound to agent '${again}' more than once`
      );
    }
  }
  const namesOf = new Map<string, string[]>();
  for (const d of live) {
    namesOf.set(
      d.plan.plugin.name,
      pluginNamesOf(d.plan.read.files, d.plan.read.validated.manifest)
    );
  }
  const snapshotNames = async (profile: string): Promise<string[]> => {
    const known = namesOf.get(profile);
    if (known) {
      return known;
    }
    const row = await db.harnessProfile.findUnique({
      select: { id: true, latestVersion: true },
      where: { name: profile },
    });
    const version = row
      ? await db.harnessProfileVersion.findUnique({
          select: { files: true, manifest: true },
          where: { profileId_version: { profileId: row.id, version: row.latestVersion } },
        })
      : null;
    let names: string[] = [];
    if (version) {
      try {
        names = pluginNamesOf(
          unpackFiles(version.files),
          version.manifest as { plugins?: string[] }
        );
      } catch {
        // An unreadable snapshot fails the run closed where it is applied.
      }
    }
    namesOf.set(profile, names);
    return names;
  };
  const bound = new Map<string, string[]>();
  for (const d of live) {
    for (const { agentKey } of d.plan.plugin.bindings) {
      let list = bound.get(agentKey);
      if (!list) {
        const head = await db.agent.findFirst({
          orderBy: { version: 'desc' },
          select: { harnessProfiles: true },
          where: { key: agentKey, ...GLOBAL_AGENT },
        });
        list = [...(head?.harnessProfiles ?? [])];
        bound.set(agentKey, list);
      }
      const { name } = d.plan.plugin;
      if (list.includes(name)) {
        continue;
      }
      const owners = new Map<string, string>();
      for (const other of list) {
        for (const plugin of await snapshotNames(other)) {
          owners.set(plugin, other);
        }
      }
      for (const plugin of new Set(await snapshotNames(name))) {
        const other = owners.get(plugin);
        if (other !== undefined) {
          return new BundlePluginCollisionError(
            'PROFILE_NAME_COLLISION',
            `Harness profiles '${other}' and '${name}' both hold a plugin named '${plugin}'; agent '${agentKey}' cannot bind both.`
          );
        }
      }
      list.push(name);
    }
  }
  return null;
}

export const HOOKS_OFF_NOTE =
  'is created with hooks off; a platform admin switches them on after reading them';

/** What a binding does, from the target agent's state; shared by preview and install. */
export function bindingOutcome(agent: {
  exists: boolean;
  runtime: string | null;
  alreadyBound: boolean;
}): 'bind' | 'already-bound' | 'agent-missing' | 'wrong-runtime' {
  if (!agent.exists) {
    return 'agent-missing';
  }
  if (agent.alreadyBound) {
    return 'already-bound';
  }
  return agent.runtime === 'claude-code' ? 'bind' : 'wrong-runtime';
}

export function bindingWarning(
  pluginName: string,
  agentKey: string,
  outcome: ReturnType<typeof bindingOutcome>
): string | null {
  if (outcome === 'agent-missing') {
    return `plugin '${pluginName}': agent '${agentKey}' is not installed, so the plugin is not bound to it`;
  }
  if (outcome === 'wrong-runtime') {
    return `plugin '${pluginName}': agent '${agentKey}' does not run on the claude-code runtime, so the plugin is not bound to it`;
  }
  return null;
}

export interface AppliedPlugin {
  action: 'create' | 'reuse';
  name: string;
  profileId: string;
  version: number;
  /** The version an agent bound to the plugin runs (the profile's latest). */
  boundVersion: number;
  plan: PluginPlan;
}

export interface ApplyPluginsResult {
  applied: AppliedPlugin[];
  warnings: string[];
}

const GLOBAL_AGENT = { scope: 'GLOBAL', teamId: null, workflowTemplateId: null } as const;

/**
 * Create the profiles that do not exist and bind the plugins, inside the install's transaction.
 * Conflicts are the caller's to have refused already. A binding cuts a new GLOBAL agent version
 * that appends the plugin name to the head's list (older versions are never touched), and only
 * for an agent that runs on `claude-code`.
 */
export async function applyPlugins(
  tx: Prisma.TransactionClient,
  decisions: readonly PluginDecision[],
  opts: { installedById: string | null; acknowledgeWarnings: boolean }
): Promise<ApplyPluginsResult> {
  const unacknowledged = warningsToAcknowledge(decisions);
  if (unacknowledged.length > 0 && !opts.acknowledgeWarnings) {
    throw new BundlePluginWarningsError(unacknowledged);
  }
  // Before any write: a refused binding must leave nothing behind.
  const collision = await bindingCollision(tx, decisions);
  if (collision) {
    throw collision;
  }
  const applied: AppliedPlugin[] = [];
  const warnings: string[] = [];
  for (const d of decisions) {
    if (d.action === 'conflict') {
      continue;
    }
    const { plugin, read } = d.plan;
    let profileId: string;
    let version: number;
    const versionWarning = reuseVersionWarning(d);
    if (versionWarning) {
      warnings.push(versionWarning);
    }
    if (d.action === 'create') {
      const { host, owner, path, ref, repo } = read.location;
      const { manifest } = read.validated;
      const created = await tx.harnessProfile.create({
        data: {
          description: manifest.description,
          // Decided by a platform admin afterwards; a bundle never turns hooks on.
          hooksEnabled: false,
          host,
          latestVersion: 1,
          name: manifest.name,
          owner,
          path,
          ref,
          repo,
          versions: {
            create: {
              approvedById: opts.installedById,
              commitSha: read.sha,
              contentHash: read.validated.contentHash,
              fileCount: read.files.length,
              fileIndex: read.validated.fileIndex,
              files: new Uint8Array(packFiles(read.files)),
              manifest,
              scanWarnings: read.warnings,
              totalBytes: read.validated.totalBytes,
              version: 1,
            },
          },
        },
        select: { id: true },
      });
      profileId = created.id;
      version = 1;
    } else {
      profileId = d.profileId;
      version = d.version;
      if (d.disabled) {
        warnings.push(
          `plugin '${plugin.name}': the profile is disabled, so an agent bound to it fails closed until it is re-enabled`
        );
      }
    }
    applied.push({
      action: d.action,
      boundVersion: boundVersionOf(d),
      name: plugin.name,
      plan: d.plan,
      profileId,
      version,
    });
    warnings.push(...(await bindPlugin(tx, plugin, opts.installedById)));
  }
  return { applied, warnings };
}

/** Append the plugin to each named GLOBAL agent by cutting a version; returns the warnings. */
async function bindPlugin(
  tx: Prisma.TransactionClient,
  plugin: BundlePlugin,
  installedById: string | null
): Promise<string[]> {
  const warnings: string[] = [];
  for (const { agentKey } of plugin.bindings) {
    await lockAgentLineage(tx, { key: agentKey, scope: 'GLOBAL' });
    const head = await tx.agent.findFirst({
      include: { skillRefs: { select: { skillId: true, sortOrder: true } } },
      orderBy: { version: 'desc' },
      where: { key: agentKey, ...GLOBAL_AGENT },
    });
    const outcome = bindingOutcome({
      alreadyBound: head?.harnessProfiles.includes(plugin.name) ?? false,
      exists: head !== null,
      runtime: head?.runtime ?? null,
    });
    const warning = bindingWarning(plugin.name, agentKey, outcome);
    if (warning) {
      warnings.push(warning);
    }
    if (outcome !== 'bind' || !head) {
      continue;
    }
    const next = await tx.agent.create({
      data: {
        channelId: head.channelId,
        createdById: installedById,
        credentialId: head.credentialId,
        description: head.description,
        harnessProfiles: [...head.harnessProfiles, plugin.name],
        inheritsModelFrom: head.inheritsModelFrom,
        isActive: head.isActive,
        isBuiltIn: head.isBuiltIn,
        isVerified: head.isVerified,
        key: head.key,
        mcpConnectionId: head.mcpConnectionId,
        modelSpec: head.modelSpec,
        name: head.name,
        orgId: head.orgId,
        origin: head.origin,
        reasoning: head.reasoning,
        runtime: head.runtime,
        scope: head.scope,
        systemPrompt: head.systemPrompt,
        teamId: head.teamId,
        toolKeys: head.toolKeys ?? undefined,
        version: head.version + 1,
        workflowTemplateId: head.workflowTemplateId,
      },
      select: { id: true },
    });
    if (head.skillRefs.length > 0) {
      await tx.agentSkillRef.createMany({
        data: head.skillRefs.map((r) => ({
          agentId: next.id,
          skillId: r.skillId,
          sortOrder: r.sortOrder,
        })),
      });
    }
  }
  return warnings;
}

/**
 * Project the skills of each plugin the install created or reused into `<plugin>:<skill>` rows,
 * after the install's transaction. Never throws: a failure is reported as a fixed warning, since
 * the install itself has committed.
 */
export async function projectInstalledPlugins(
  db: PrismaClient,
  applied: readonly AppliedPlugin[],
  createdById: string | null
): Promise<string[]> {
  const warnings: string[] = [];
  for (const a of applied) {
    const { read } = a.plan;
    // A reused older snapshot is never projected over the latest one's skills.
    if (a.version !== a.boundVersion) {
      continue;
    }
    try {
      const res = await projectPluginSkills(db, {
        commitSha: read.sha,
        createdById,
        files: read.files,
        manifest: read.validated.manifest,
        profileId: a.profileId,
        profileName: a.name,
        version: a.version,
      });
      if (res.created.length + res.updated.length > 0) {
        warnings.push(
          `plugin '${a.name}': projected ${res.created.length} new and ${res.updated.length} updated skill(s) for runtimes other than claude-code`
        );
      }
      for (const r of res.refused) {
        warnings.push(`plugin '${a.name}': skill '${r.name}' not projected: ${r.reason}`);
      }
    } catch {
      warnings.push(`plugin '${a.name}': its skills could not be projected`);
    }
  }
  return warnings;
}
