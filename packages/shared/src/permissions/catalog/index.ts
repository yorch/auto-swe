import { automationCapabilities } from './automations.js';
import { orgCapabilities } from './org.js';
import { platformCapabilities } from './platform.js';
import { repoCapabilities } from './repos.js';
import { runCapabilities } from './runs.js';
import { teamCapabilities } from './teams.js';
import { templateCapabilities } from './templates.js';

/** The domain files, kept apart so the test can see a key declared twice. */
export const CATALOG_PARTS = {
  automations: automationCapabilities,
  org: orgCapabilities,
  platform: platformCapabilities,
  repos: repoCapabilities,
  runs: runCapabilities,
  teams: teamCapabilities,
  templates: templateCapabilities,
} as const;

/** Every capability, by key. The one table routes, the web and the generated reference read. */
export const CATALOG = {
  ...platformCapabilities,
  ...orgCapabilities,
  ...teamCapabilities,
  ...repoCapabilities,
  ...templateCapabilities,
  ...runCapabilities,
  ...automationCapabilities,
} as const;

/** A capability key. A typo is a compile error. */
export type CapabilityKey = keyof typeof CATALOG;

export function isCapabilityKey(key: string): key is CapabilityKey {
  return Object.hasOwn(CATALOG, key);
}

export { defineCapabilities } from './define.js';
