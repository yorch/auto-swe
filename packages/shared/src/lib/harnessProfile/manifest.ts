import { z } from 'zod';
import { safeDisplayPath } from '../skillSource/display.js';

/** The only extra built-in tools a profile may grant the harness. */
export const PROFILE_TOOLS = ['Skill', 'Agent'] as const;
export type ProfileTool = (typeof PROFILE_TOOLS)[number];

export const MAX_PROFILE_DESCRIPTION = 1000;
export const MAX_PROFILE_PLUGINS = 20;

export const ProfileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

/** `profile.json`. Strict: a key this version does not know is an error, not ignored. */
export const ProfileManifestSchema = z.strictObject({
  description: z.string().min(1).max(MAX_PROFILE_DESCRIPTION),
  instructions: z.string().min(1).max(500).optional(),
  name: ProfileNameSchema,
  plugins: z.array(z.string().min(1).max(500)).max(MAX_PROFILE_PLUGINS).optional(),
  tools: z.array(z.enum(PROFILE_TOOLS)).max(PROFILE_TOOLS.length).optional(),
});
export type ProfileManifest = z.infer<typeof ProfileManifestSchema>;

/**
 * Zod's own messages can quote the offending input, and a manifest is repository text, so every
 * issue is reported as a fixed sentence about its field.
 */
export function manifestIssues(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map((issue) => {
        const field = safeDisplayPath(issue.path.map(String).join('.') || 'profile.json');
        if (issue.code === 'unrecognized_keys') {
          return 'profile.json has a key this version does not know';
        }
        if (issue.path[0] === 'tools') {
          return 'profile.json tools may only list Skill and Agent';
        }
        return `profile.json: ${field} is missing or invalid`;
      })
    ),
  ];
}
