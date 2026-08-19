import type { z } from 'zod';
import type { ConfigScope, Role } from '../generated/prisma/enums.js';

/// The five scope levels of the platform-wide config cascade, most specific
/// first. `resolveSetting` walks them in this order and takes the first
/// override it finds; a key with no override anywhere falls back to its
/// definition default.
export const SETTING_SCOPE_ORDER = [
  'WORKFLOW_TEMPLATE',
  'CHANNEL',
  'TEAM',
  'ORGANIZATION',
  'GLOBAL',
] as const satisfies readonly ConfigScope[];

export type SettingScope = (typeof SETTING_SCOPE_ORDER)[number];

/// The scopes an override may be attached to below GLOBAL. GLOBAL is always
/// available, so a definition lists only the narrower scopes it permits.
export type OverridableScope = Exclude<SettingScope, 'GLOBAL'>;

/// Groups exist so the admin UI can render one form per subsystem and so a
/// permission grant can name a whole area (`channel.*`) instead of every key.
export const SETTING_GROUPS = ['channel', 'memory', 'workflow', 'workspace'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

/// One configurable knob, declared once and used everywhere: the definition is
/// what validates a write, what the admin form renders from, what the
/// permission check consults, and what the resolver falls back to. Adding a
/// knob means adding a definition — not a migration, a Zod body schema, a
/// resolver branch and a hand-written form field.
/// A setting's identity is the property it is stored under in
/// `SETTING_DEFINITIONS` — not a field here. That key is the primary key of the
/// stored override and the subject of permission grants, so renaming one
/// orphans every row and grant that referenced it; carrying it twice would only
/// create a way for the two to disagree.
export interface SettingDefinition<T = unknown> {
  group: SettingGroup;
  /// Short noun phrase for the admin form.
  label: string;
  /// What the knob does and what changing it costs. Rendered under the input.
  description: string;
  /// Validates every write and every value read back out of the database, so a
  /// row written before a definition changed can never surface as the wrong
  /// type — it falls back to the default instead.
  schema: z.ZodType<T>;
  /// Value used when no override exists at any scope. This is the constant the
  /// setting replaced, so an unconfigured deployment behaves exactly as before.
  defaultValue: T;
  /// Scopes below GLOBAL where an override may be set. Empty means the knob is
  /// platform-wide only.
  overridableAt: readonly OverridableScope[];
  /// Floor for who may change it. Grants can name who *may* write a key, but
  /// never below this role.
  requiredRole: Role;
  /// When true the value is snapshotted into `WorkflowRun.pinnedSettings` at
  /// run start and read from there for the life of the run. Use it for
  /// anything a run makes a structural decision on — fan-out width, transition
  /// ceilings, budget tiers — where a mid-run change would make the second half
  /// of a run disagree with the first. Everything else re-resolves per call,
  /// which is what lets a model edit land inside an in-flight workflow.
  runPinned: boolean;
  /// True when a process must restart before the new value takes effect.
  /// Surfaced in the UI; the resolver does not enforce it.
  restartRequired: boolean;
  /// Environment variable consulted between the cascade and the default, so a
  /// deployment already driving this value from the environment keeps working
  /// until an admin saves an override.
  envVar?: string;
  /// Parses the env var's raw string. Returning undefined means "unset or
  /// unparseable" and falls through to `defaultValue`.
  parseEnv?: (raw: string) => T | undefined;
  /// Rendered next to the input (`minutes`, `MB`, `0–1`).
  unit?: string;
}

/// Scoping context for a settings read. Every field is optional: a resolve with
/// none of them set consults GLOBAL only, which is what happens outside a
/// workflow (worker boot, CLI, tests).
export interface SettingResolveCtx {
  teamId?: string;
  orgId?: string;
  channelId?: string;
  workflowTemplateId?: string;
  /// Run-start snapshot of every `runPinned` setting. Present on activities
  /// executing inside a workflow run; consulted before the live cascade.
  pinnedSettings?: Record<string, unknown>;
}

/// Where a resolved value actually came from. Returned by the effective-config
/// view so an operator can see which scope is winning without reading source.
export type SettingSource = SettingScope | 'PINNED' | 'ENV' | 'DEFAULT';

export interface ResolvedSetting<T = unknown> {
  key: string;
  value: T;
  source: SettingSource;
}
