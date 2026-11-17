import type { Prisma, PrismaClient } from '@prisma/client';

/** A file of an approved plugin snapshot, as {@link unpackFiles} returns it. */
export interface ProjectionFile {
  path: string;
  bytes: Buffer;
  mode: string;
}

export interface ProjectPluginSkillsInput {
  profileId: string;
  profileName: string;
  version: number;
  files: ProjectionFile[];
  /** The version's parsed `profile.json`; `plugins` lists the plugin directories. */
  manifest: { plugins?: string[] };
}

export interface ProjectPluginSkillsResult {
  created: string[];
  updated: string[];
  /** Skills left alone: hand-edited, name conflict, or scan warnings that block. */
  refused: { name: string; reason: string }[];
}

/**
 * Projects the skills of an approved plugin snapshot into `Skill` rows named
 * `<plugin>:<skill>` (derived, read-only, unverified) so runtimes other than
 * `claude-code` can use them. The implementation lives in this file's owner task;
 * callers rely only on this signature.
 */
export async function projectPluginSkills(
  _db: PrismaClient | Prisma.TransactionClient,
  _input: ProjectPluginSkillsInput
): Promise<ProjectPluginSkillsResult> {
  throw new Error('projectPluginSkills is not implemented yet');
}
