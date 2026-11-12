import { parse as parseYaml, stringify } from 'yaml';
import { z } from 'zod';
import { REPO_GATE_COMMAND_KEYS } from '../types/api.js';
import { type PreviewConfigInput, PreviewConfigSchema } from './previewConfig.js';

export const REPO_GATES_FILE = '.auto-swe/gates.yml';
export const REPO_PREVIEW_FILE = '.auto-swe/preview.yml';
export const REPO_CONFIG_FILE_MAX_BYTES = 64 * 1024;

export const RepoGateCommandsSchema = z.partialRecord(
  z.enum(REPO_GATE_COMMAND_KEYS),
  z.string().max(4000).nullable()
);
export type RepoGateFileCommands = z.infer<typeof RepoGateCommandsSchema>;

function parseConfigYaml<T>(
  text: string,
  schema: z.ZodType<T>
): { ok: true; value: T } | { ok: false; error: string } {
  if (Buffer.byteLength(text, 'utf8') > REPO_CONFIG_FILE_MAX_BYTES) {
    return { error: `exceeds ${REPO_CONFIG_FILE_MAX_BYTES} bytes`, ok: false };
  }
  try {
    const parsed = schema.safeParse(parseYaml(text, { maxAliasCount: 50 }) ?? {});
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { error: parsed.error.message, ok: false };
  } catch (error) {
    return {
      error: `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
}

export function parseRepoGatesYaml(text: string) {
  return parseConfigYaml(text, RepoGateCommandsSchema);
}

export function parseRepoPreviewYaml(text: string) {
  return parseConfigYaml(text, PreviewConfigSchema);
}

export function repoGatesToYaml(commands: RepoGateFileCommands): string {
  return stringify(RepoGateCommandsSchema.parse(commands), { lineWidth: 0, sortMapEntries: true });
}

export function repoPreviewToYaml(config: PreviewConfigInput): string {
  return stringify(PreviewConfigSchema.parse(config), { lineWidth: 0, sortMapEntries: true });
}
