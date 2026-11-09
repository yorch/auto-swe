import { parse, stringify } from 'yaml';
import { z } from 'zod';
import {
  ToolInstallError,
  ToolKeySchema,
  type ToolRequest,
  ToolVersionSchema,
} from './toolCatalog.js';

/**
 * A repository's `.auto-swe/tools.yml`: the tools its runs need that the executor image lacks.
 * The file names catalog entries and nothing else — no URL, script, checksum or include — so
 * whoever can merge to the repository chooses among entries an admin already vetted. It is read
 * from the base ref and only honoured when an admin enabled it for the connection.
 */

export const TOOLS_FILE_PATH = '.auto-swe/tools.yml';
export const MAX_TOOLS_FILE_BYTES = 8 * 1024;
/** A file may name this many tools; the per-run `maxTools` setting is the tighter, tunable cap. */
export const MAX_TOOLS_IN_FILE = 32;

/** The file is malformed, too large, or names something it may not. Never retried. */
export class ToolsFileError extends ToolInstallError {
  constructor(message: string) {
    super(message, { retryable: false });
    this.name = 'ToolsFileError';
  }
}

export const ToolRequestSchema = z.strictObject({
  key: ToolKeySchema,
  version: ToolVersionSchema.optional(),
});

export const ToolsFileSchema = z.strictObject({
  tools: z.array(ToolRequestSchema).max(MAX_TOOLS_IN_FILE).default([]),
  version: z.literal(1),
});

const describe = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ');

/**
 * Parse the file's text. Strict: unknown keys, aliases, duplicate YAML keys, a wrong `version`,
 * an over-long list and anything over {@link MAX_TOOLS_FILE_BYTES} are all refused, so a
 * malformed file fails the run's setup instead of being half-read. The same key named twice is
 * refused too; an ambiguous file has no right answer.
 */
export function parseToolsFile(text: string): ToolRequest[] {
  if (Buffer.byteLength(text, 'utf8') > MAX_TOOLS_FILE_BYTES) {
    throw new ToolsFileError(`${TOOLS_FILE_PATH} is larger than ${MAX_TOOLS_FILE_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    // `maxAliasCount: 0` refuses every alias, which also closes entity-expansion attacks.
    raw = parse(text, { maxAliasCount: 0 });
  } catch (err) {
    throw new ToolsFileError(
      `${TOOLS_FILE_PATH} is not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : 'parse error'}`
    );
  }
  const parsed = ToolsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ToolsFileError(`${TOOLS_FILE_PATH} is invalid: ${describe(parsed.error)}`);
  }
  const seen = new Set<string>();
  for (const tool of parsed.data.tools) {
    if (seen.has(tool.key)) {
      throw new ToolsFileError(`${TOOLS_FILE_PATH} names '${tool.key}' more than once`);
    }
    seen.add(tool.key);
  }
  return parsed.data.tools.map((t) =>
    t.version ? { key: t.key, version: t.version } : { key: t.key }
  );
}

const HEADER = `# auto-swe on-demand tools (.auto-swe/tools.yml)
#
# Tools your runs need that the executor image does not ship. Each entry names a tool the platform
# administrators already vetted: this file cannot supply a URL, script or checksum, and it can only
# ever pick among the catalog's entries. Leave \`version\` out to take the newest active one.
#
# The platform reads this file from the base branch, and only when an administrator has enabled
# it for this repository, so merging it changes nothing until they do.
`;

/** The file's text for `tools`: deterministic, and it parses back with {@link parseToolsFile}. */
export function renderToolsFile(tools: readonly ToolRequest[]): string {
  // Code-unit order, not `localeCompare`: that depends on the ICU data and locale of the process,
  // so the gateway and the worker could render (and hash) the same request differently.
  const sorted = [...tools].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const parsedTools = ToolsFileSchema.safeParse({ tools: sorted, version: 1 });
  if (!parsedTools.success) {
    throw new ToolsFileError(`cannot render ${TOOLS_FILE_PATH}: ${describe(parsedTools.error)}`);
  }
  const checked = parsedTools.data;
  const body = stringify(
    {
      tools: checked.tools.map((t) =>
        t.version ? { key: t.key, version: t.version } : { key: t.key }
      ),
      version: 1,
    },
    { lineWidth: 0 }
  );
  const text = `${HEADER}${body}`;
  parseToolsFile(text);
  return text;
}

/**
 * The tools a run installs: the connection's admin list first, then the file's, one per key (an
 * explicit version from the admin list beats the file's), minus the connection's deny list, which
 * wins over both. More than `max` is an error rather than a silent truncation: a run that
 * declared a tool must either get it or fail at setup.
 */
export function mergeToolRequests(
  sources: { admin: readonly ToolRequest[]; file: readonly ToolRequest[]; deny: readonly string[] },
  max: number
): ToolRequest[] {
  const denied = new Set(sources.deny);
  const byKey = new Map<string, ToolRequest>();
  for (const request of [...sources.admin, ...sources.file]) {
    if (!denied.has(request.key) && !byKey.has(request.key)) {
      byKey.set(request.key, request);
    }
  }
  if (byKey.size > max) {
    throw new ToolInstallError(
      `${byKey.size} tools were requested but at most ${max} may be installed per run (setting workspace.toolInstall.maxTools)`
    );
  }
  return [...byKey.values()];
}
