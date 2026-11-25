import { pluginMcpServers } from '../marketplace/mcp.js';
import type { PluginMcpServer } from '../marketplace/types.js';
import { type ProjectionFile, pluginNameOf } from './projection.js';

const PLUGIN_MANIFEST = '.claude-plugin/plugin.json';
const MCP_JSON = '.mcp.json';

/** Fixed reasons; never parser or file text. */
export const PLUGIN_MCP_UNREADABLE = {
  invalid: 'the file is not valid JSON',
  missing: 'the referenced file is not in the plugin',
  name: 'the plugin name is not usable',
} as const;

/** One MCP server a plugin of an approved snapshot declares. */
export interface DeclaredPluginMcpServer extends PluginMcpServer {
  /** The plugin's name, as the skill projection names it. */
  plugin: string;
  /** True when a different plugin of the same profile declares a server with this name. */
  duplicate: boolean;
}

/** A declaration that could not be read; the plugin's other servers are still listed. */
export interface UnreadablePluginMcp {
  plugin: string;
  /** Path inside the snapshot, display-safe. */
  file: string;
  reason: (typeof PLUGIN_MCP_UNREADABLE)[keyof typeof PLUGIN_MCP_UNREADABLE];
}

export interface DeclaredPluginMcp {
  servers: DeclaredPluginMcpServer[];
  unreadable: UnreadablePluginMcp[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return {
      ok: true,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    };
  } catch {
    return { ok: false };
  }
}

/** A path named by `plugin.json`, relative to the plugin directory, or null when it escapes it. */
function insidePlugin(raw: string): string | null {
  const parts = raw.replace(/^\.\//, '').split('/');
  if (raw.startsWith('/') || raw.includes('\\') || raw.includes('\0')) {
    return null;
  }
  if (parts.some((s) => s === '' || s === '.' || s === '..')) {
    return null;
  }
  return parts.join('/');
}

const shownPath = (s: string) =>
  (s.length > 200 ? `${s.slice(0, 197)}...` : s).replace(/\p{C}/gu, '?');

/**
 * Every MCP server the plugins of an UNPACKED profile snapshot declare, from each plugin's
 * `.mcp.json` and from `mcpServers` in its `.claude-plugin/plugin.json` (an object, or a path, or a
 * list of paths, to JSON files inside the plugin). Parsing is {@link pluginMcpServers}; this adds
 * where to look. Within one plugin a name declared twice is listed once (`.mcp.json` first). Never
 * throws: a file that cannot be read becomes an `unreadable` entry with a fixed reason. A server
 * name is `shown()`-sanitised by the parser, so it is the mapping key only through this function.
 */
export function declaredPluginMcpServers(
  files: ProjectionFile[],
  manifest: { plugins?: string[] }
): DeclaredPluginMcp {
  const out: DeclaredPluginMcp = { servers: [], unreadable: [] };
  try {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const seenPlugins = new Set<string>();
    for (const rawDir of manifest.plugins ?? []) {
      const dir = rawDir.replace(/\/+$/, '');
      const at = (rel: string) => (dir === '' ? rel : `${dir}/${rel}`);
      const plugin = pluginNameOf(dir, byPath);
      if (plugin === null) {
        out.unreadable.push({
          file: shownPath(at(PLUGIN_MANIFEST)),
          plugin: shownPath(dir.split('/').at(-1) ?? ''),
          reason: PLUGIN_MCP_UNREADABLE.name,
        });
        continue;
      }
      if (seenPlugins.has(plugin.toLowerCase())) {
        continue;
      }
      seenPlugins.add(plugin.toLowerCase());

      const names = new Set<string>();
      const take = (bytes: Buffer, file: string) => {
        if (!parseJson(bytes).ok) {
          out.unreadable.push({
            file: shownPath(file),
            plugin,
            reason: PLUGIN_MCP_UNREADABLE.invalid,
          });
          return;
        }
        const rootShape = !/(^|\/)plugin\.json$/.test(file);
        for (const { ambiguous, ...s } of pluginMcpServers(bytes, { rootShape })) {
          if (ambiguous) {
            // Several declared names read the same once sanitised: all are flagged, none mappable.
            out.servers.push({ ...s, duplicate: true, plugin });
          } else if (!names.has(s.name)) {
            names.add(s.name);
            out.servers.push({ ...s, duplicate: false, plugin });
          }
        }
      };
      const fromPath = (rel: string) => {
        const inside = insidePlugin(rel);
        const f = inside === null ? undefined : byPath.get(at(inside));
        if (f) {
          take(f.bytes, f.path);
        } else {
          out.unreadable.push({
            file: shownPath(at(rel)),
            plugin,
            reason: PLUGIN_MCP_UNREADABLE.missing,
          });
        }
      };

      const mcpJson = byPath.get(at(MCP_JSON));
      if (mcpJson) {
        take(mcpJson.bytes, mcpJson.path);
      }

      const pluginJson = byPath.get(at(PLUGIN_MANIFEST));
      if (pluginJson) {
        const parsed = parseJson(pluginJson.bytes);
        if (!parsed.ok) {
          out.unreadable.push({
            file: shownPath(pluginJson.path),
            plugin,
            reason: PLUGIN_MCP_UNREADABLE.invalid,
          });
        } else if (isObject(parsed.value)) {
          const inline = parsed.value.mcpServers;
          if (isObject(inline)) {
            take(Buffer.from(JSON.stringify({ mcpServers: inline })), pluginJson.path);
          } else if (typeof inline === 'string') {
            fromPath(inline);
          } else if (Array.isArray(inline)) {
            for (const entry of inline) {
              if (typeof entry === 'string') {
                fromPath(entry);
              }
            }
          }
        }
      }
    }

    const owners = new Map<string, Set<string>>();
    for (const s of out.servers) {
      const set = owners.get(s.name) ?? new Set<string>();
      set.add(s.plugin);
      owners.set(s.name, set);
    }
    for (const s of out.servers) {
      s.duplicate = s.duplicate || (owners.get(s.name)?.size ?? 0) > 1;
    }
  } catch {
    // A scan of declarations must never abort its caller.
  }
  return out;
}
