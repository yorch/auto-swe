/** The fields of a skill row that say it was projected from a plugin. */
interface PluginSkillFields {
  name: string;
  /** Set by the gateway on a projected skill; absent or null on an ordinary one. */
  pluginProfileId?: string | null;
  pluginVersion?: number | null;
}

/**
 * Whether a skill row is a derived copy of a plugin's skill, named `<plugin>:<skill>`. The gateway
 * marks one with `pluginProfileId`; until it does, the namespaced name is the signal. A hand-made
 * skill cannot carry a colon in its name, so the name test does not catch an ordinary skill.
 */
export function isPluginSkill(skill: PluginSkillFields): boolean {
  if (skill.pluginProfileId) {
    return true;
  }
  return /^[^:]+:[^:]+$/.test(skill.name);
}

/** The plugin and skill parts of a namespaced name, or null when it has none. */
export function splitPluginSkillName(name: string): { plugin: string; skill: string } | null {
  const m = /^([^:]+):([^:]+)$/.exec(name);
  return m ? { plugin: m[1] as string, skill: m[2] as string } : null;
}

export const PLUGIN_SKILL_READ_ONLY =
  'This skill is projected from a plugin and is read-only. Its text changes when a platform admin accepts a new version of the plugin.';
