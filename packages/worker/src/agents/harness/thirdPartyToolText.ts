import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { memoryInjectionMatches } from '../../lib/memoryGuard.js';

/** What a tool description becomes when it matches an injection pattern (or cannot be screened). */
export const DESCRIPTION_WITHHELD = '[description withheld: matched a prompt-injection pattern]';

export const MAX_TOOL_DESCRIPTION = 500;
export const MAX_PROPERTY_DESCRIPTION = 200;
/** The most description text one tool carries in all (its own plus its schema's). */
export const MAX_TOOL_TEXT_TOTAL = 3_000;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_NODES = 500;

/** Control, format and line/paragraph separator characters become a space; runs collapse. */
export function stripControlText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Truncation by code points, so a surrogate pair is never cut in half. */
function truncate(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('');
}

/**
 * Neutralises the text of tools served by a third-party (plugin) MCP server before it reaches the
 * harness's tool list: control and format characters are removed, each tool description is cut to
 * {@link MAX_TOOL_DESCRIPTION} characters and each schema description or title to
 * {@link MAX_PROPERTY_DESCRIPTION}, a tool's text is capped in total, and text matching an
 * INJECTION pattern is replaced by {@link DESCRIPTION_WITHHELD}. A scan that fails or cannot
 * complete counts as a match. Names and the structural parts of the schema are untouched. Never
 * throws.
 */
export async function neutraliseThirdPartyTools(tools: readonly Tool[]): Promise<Tool[]> {
  const out: Tool[] = [];
  for (const tool of tools) {
    try {
      out.push(await neutraliseTool(tool));
    } catch {
      out.push(stripAllText(tool));
    }
  }
  return out;
}

async function screen(text: string): Promise<string> {
  if (!text) {
    return text;
  }
  try {
    const scan = await memoryInjectionMatches([text]);
    return scan.matches.length > 0 || scan.incomplete || scan.loadFailed
      ? DESCRIPTION_WITHHELD
      : text;
  } catch {
    return DESCRIPTION_WITHHELD;
  }
}

/** The tool with every description-like field dropped: the fallback when neutralising threw. */
function stripAllText(tool: Tool): Tool {
  const { description: _d, title: _t, ...rest } = tool;
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > MAX_SCHEMA_DEPTH || node === null || typeof node !== 'object') {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((n) => walk(n, depth + 1));
    }
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'description' || k === 'title' || k === 'examples') {
        continue;
      }
      copy[k] = walk(v, depth + 1);
    }
    return copy;
  };
  return {
    ...rest,
    inputSchema: walk(tool.inputSchema, 0) as Tool['inputSchema'],
    ...(rest.outputSchema ? { outputSchema: walk(rest.outputSchema, 0) as never } : {}),
    ...(rest.annotations ? { annotations: { ...rest.annotations, title: undefined } } : {}),
  } as Tool;
}

async function neutraliseTool(tool: Tool): Promise<Tool> {
  let budget = MAX_TOOL_TEXT_TOTAL;
  let nodes = 0;
  const clean = async (raw: unknown, max: number): Promise<string | undefined> => {
    if (typeof raw !== 'string') {
      return undefined;
    }
    const text = truncate(stripControlText(raw), Math.min(max, budget));
    if (text.length === 0) {
      return undefined;
    }
    budget -= text.length;
    return screen(text);
  };
  const walk = async (node: unknown, depth: number): Promise<unknown> => {
    if (node === null || typeof node !== 'object') {
      return node;
    }
    if (depth > MAX_SCHEMA_DEPTH || ++nodes > MAX_SCHEMA_NODES) {
      return Array.isArray(node) ? [] : {};
    }
    if (Array.isArray(node)) {
      const items: unknown[] = [];
      for (const item of node) {
        items.push(await walk(item, depth + 1));
      }
      return items;
    }
    const copy: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'description' || key === 'title') {
        // A property NAMED description is a map entry (its value is an object), not text.
        if (typeof value === 'string') {
          const text = await clean(value, MAX_PROPERTY_DESCRIPTION);
          if (text !== undefined) {
            copy[key] = text;
          }
          continue;
        }
      }
      if (key === 'examples') {
        continue;
      }
      copy[key] = await walk(value, depth + 1);
    }
    return copy;
  };

  const description = await clean(tool.description, MAX_TOOL_DESCRIPTION);
  const title = await clean(tool.title, MAX_PROPERTY_DESCRIPTION);
  const inputSchema = (await walk(tool.inputSchema, 0)) as Tool['inputSchema'];
  const outputSchema =
    tool.outputSchema === undefined
      ? undefined
      : ((await walk(tool.outputSchema, 0)) as Tool['outputSchema']);
  const { description: _d, title: _t, annotations, ...rest } = tool;
  let nextAnnotations = annotations;
  if (annotations && 'title' in annotations) {
    const { title: annotationTitle, ...others } = annotations;
    const cleaned = await clean(annotationTitle, MAX_PROPERTY_DESCRIPTION);
    nextAnnotations = cleaned === undefined ? others : { ...others, title: cleaned };
  }
  return {
    ...rest,
    ...(description !== undefined ? { description } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(nextAnnotations ? { annotations: nextAnnotations } : {}),
    inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
  };
}
