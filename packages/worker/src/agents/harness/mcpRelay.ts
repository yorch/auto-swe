import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { auditLog } from '../../lib/activityLog.js';
import { redactString } from '../../lib/agentTracer.js';
import type { McpConnectionTarget } from '../../lib/config/mcpConnection.js';
import { mcpToolIsReadOnly, recordEffect } from '../../lib/effectLedger.js';
import { getErrorMessage } from '../../lib/errors.js';
import { screenMcpResult } from '../mcpScreen.js';
import {
  bearerFetch,
  guardedMcpFetch,
  type McpTracer,
  originScopedFetch,
  parseMcpServerRef,
  scrubToken,
  selectAllowedMcpTools,
  withTimeout,
} from '../mcpTools.js';
import { neutraliseThirdPartyTools } from './thirdPartyToolText.js';

const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

/**
 * An agent's MCP connection, served to a harness from the worker.
 *
 * The worker connects to the remote server (through the same guarded fetch,
 * credential and private-network rules as the Mastra loop's binding) and
 * offers its tools, with their own schemas, through an in-process MCP server
 * the harness's client talks to over its existing pipe. Each call the harness
 * makes is run here, so the connection's token and headers never enter the
 * workspace container, and each is audit-logged as the Mastra binding's are.
 */
export interface McpRelay {
  /**
   * A fresh in-process server for one harness session to connect to; the remote
   * connection behind it is shared. Close it when the session ends.
   */
  createServer(): McpServer;
  /**
   * Run one call on the remote server, for a harness whose loop runs in the
   * worker and takes the tools directly. Audit-logged like a call through the
   * server; a failure comes back as an error result, never a throw.
   */
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult>;
  /** The remote tools, as the harness sees them (names unprefixed). */
  tools: readonly Tool[];
  /** Per-call timeout, for a harness that bounds calls itself. */
  callTimeoutMs: number;
  /** Disconnects from the remote server. Safe to call more than once; never throws. */
  close(): Promise<void>;
}

type McpFetch = ReturnType<typeof bearerFetch>;

async function connect(url: URL, fetch: McpFetch, timeoutMs: number): Promise<Client> {
  // Streamable HTTP first, then the legacy SSE transport, as the Mastra client does.
  const attempt = async (transport: StreamableHTTPClientTransport | SSEClientTransport) => {
    const client = new Client({ name: 'auto-swe-harness-relay', version: '1.0.0' });
    try {
      await withTimeout(client.connect(transport), timeoutMs, `MCP connection to ${url}`);
      return client;
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
  };
  try {
    return await attempt(new StreamableHTTPClientTransport(url, { fetch }));
  } catch (streamable) {
    try {
      return await attempt(new SSEClientTransport(url, { fetch }));
    } catch {
      throw streamable;
    }
  }
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

const failure = (text: string): CallToolResult => ({
  content: [{ text, type: 'text' }],
  isError: true,
});

/** The shortest host worth scrubbing from a result: a degenerate one would corrupt ordinary text. */
const MIN_SCRUBBED_HOST = 4;
/** The shortest path, query value, userinfo part or path segment worth scrubbing. */
const MIN_SCRUBBED_SECRET = 4;
/** At most this many names are matched, and none is longer than this, bounding the work per string. */
const MAX_NAMES = 64;
const MAX_NAME_LENGTH = 8_192;
const MAX_NAMES_TOTAL_LENGTH = 65_536;
/** Deeper than this a subtree is replaced, never returned raw. */
const MAX_SCRUB_DEPTH = 16;
const ENCODED_FIELDS = new Set(['data', 'blob']);

type NameKind = 'host' | 'url' | 'path' | 'secret';
interface ScrubName {
  /** Lower-cased when `ci`. */
  text: string;
  ci: boolean;
  kind: NameKind;
  /** A base64 spelling: a trailing `=` padding belongs to the match. */
  b64?: boolean;
}

const isAlnum = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9]/.test(c);

/** A host or address is not a piece of a longer one: `wiki.corp.io`, `bob@corp.io`, `110.0.0.5`. */
function hostPrevOk(s: string, i: number): boolean {
  const c = s[i - 1];
  return c === undefined || !(isAlnum(c) || c === '.' || c === '-' || c === '_' || c === '@');
}
/** ...nor the head of one: `corp.ion`, `corp.io-x`, `corp.io.evil`, `10.0.0.55`. */
function hostNextOk(s: string, i: number): boolean {
  const c = s[i];
  if (c === undefined) {
    return true;
  }
  if (isAlnum(c) || c === '-' || c === '_') {
    return false;
  }
  return !(c === '.' && isAlnum(s[i + 1]));
}
function pathNextOk(s: string, i: number): boolean {
  const c = s[i];
  return c === undefined || !(isAlnum(c) || c === '-' || c === '_');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function addEncodings(set: Set<string>, value: string) {
  set.add(value);
  set.add(safeDecode(value));
  for (const v of [value, safeDecode(value)]) {
    set.add(encodeURIComponent(v));
    set.add(encodeURI(v));
  }
}

/**
 * The names that identify a connection's own endpoint, most specific first, capped. Nothing here
 * is built into a RegExp, so a URL's metacharacters mean nothing.
 *
 * Matched case-insensitively and at boundaries: the URL as stored, its normalised form, the
 * credential-free origin and path (with and without a trailing slash, so a stored URL with no path
 * still matches inside `https://host/other/page` and only the endpoint prefix is replaced), and the
 * host with and without the port. A connection whose hostname is an ordinary word (`localhost`)
 * has that word scrubbed wherever it stands alone as a token.
 *
 * Matched literally (case-sensitive, no boundaries, at least {@link MIN_SCRUBBED_SECRET} chars): the
 * pathname, each path segment of 8+ characters holding a digit, every query value and the fragment,
 * the user name and password; each also percent-encoded and percent-decoded, and the exact URL, each
 * query value and each userinfo part in base64 and base64url (unpadded, so a padded copy matches
 * too). Not covered: a secret split across lines or tokens, a hex, rot13 or double-encoded copy, a
 * base64 copy that is embedded at a non-zero byte offset of a larger encoded blob, and path
 * segments that are short or have no digit.
 */
function endpointNames(url: string): ScrubName[] {
  const out: ScrubName[] = [];
  const seen = new Set<string>();
  let total = 0;
  const push = (text: string, kind: NameKind, ci: boolean, min: number, b64 = false) => {
    const key = ci ? text.toLowerCase() : text;
    if (
      text.length < min ||
      text.length > MAX_NAME_LENGTH ||
      out.length >= MAX_NAMES ||
      total + text.length > MAX_NAMES_TOTAL_LENGTH ||
      seen.has(`${kind}:${ci}:${key}`)
    ) {
      return;
    }
    seen.add(`${kind}:${ci}:${key}`);
    total += text.length;
    out.push({ b64, ci, kind, text: key });
  };
  const trimSlash = (s: string) => s.replace(/\/+$/, '');
  const urlForms: string[] = [url];
  const hosts: string[] = [];
  const secrets = new Set<string>();
  const paths: string[] = [];
  try {
    const parsed = new URL(url);
    urlForms.push(parsed.href, `${parsed.origin}${parsed.pathname}`, parsed.origin);
    for (const host of [parsed.host, parsed.hostname]) {
      hosts.push(host);
    }
    if (parsed.pathname.length >= MIN_SCRUBBED_SECRET) {
      paths.push(parsed.pathname);
      for (const segment of parsed.pathname.split('/')) {
        if (segment.length >= 8 && /\d/.test(segment)) {
          secrets.add(segment);
        }
      }
    }
    for (const pair of parsed.search.slice(1).split('&')) {
      const eq = pair.indexOf('=');
      if (eq >= 0) {
        addEncodings(secrets, pair.slice(eq + 1));
      }
    }
    if (parsed.hash.length > 1) {
      addEncodings(secrets, parsed.hash.slice(1));
    }
    if (parsed.username) {
      addEncodings(secrets, parsed.username);
    }
    if (parsed.password) {
      addEncodings(secrets, parsed.password);
    }
    if (parsed.username && parsed.password) {
      addEncodings(secrets, `${parsed.username}:${parsed.password}`);
    }
  } catch {
    // An unparseable ref is refused before a relay is opened; the exact string still scrubs.
  }
  for (const form of urlForms) {
    push(trimSlash(form), 'url', true, 1);
  }
  for (const form of urlForms) {
    push(encodeURIComponent(form), 'secret', false, MIN_SCRUBBED_SECRET);
  }
  for (const host of hosts) {
    push(host, 'host', true, MIN_SCRUBBED_HOST);
  }
  for (const path of paths) {
    for (const p of [path, trimSlash(path)]) {
      push(p, 'path', false, MIN_SCRUBBED_SECRET);
      push(encodeURI(p), 'path', false, MIN_SCRUBBED_SECRET);
    }
  }
  for (const secret of secrets) {
    push(secret, 'secret', false, MIN_SCRUBBED_SECRET);
  }
  const encoded: string[] = [url, ...secrets];
  for (const value of encoded) {
    if (value.length < MIN_SCRUBBED_SECRET) {
      continue;
    }
    const b64 = Buffer.from(value).toString('base64').replace(/=+$/, '');
    push(b64, 'secret', false, 6, true);
    push(b64.replace(/\+/g, '-').replace(/\//g, '_'), 'secret', false, 6, true);
  }
  return out.sort((a, b) => b.text.length - a.text.length);
}

const asciiLower = (s: string): string => {
  const lower = s.toLowerCase();
  // Lower-casing some characters changes the length, which would shift every index.
  return lower.length === s.length ? lower : s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
};

const scrubbers = new Map<string, (text: string) => string>();

/**
 * A function that replaces every occurrence of the connection's endpoint names (see
 * {@link endpointNames}) in a string with `[endpoint]`. All matches are found against the one
 * original string and spliced once (overlaps merged), so the work is linear in the string for each
 * of the capped names and a replacement cannot create or hide a match.
 */
function endpointScrubber(url: string): (text: string) => string {
  const cached = scrubbers.get(url);
  if (cached) {
    return cached;
  }
  const names = endpointNames(url);
  const shortest = names.reduce((m, n) => Math.min(m, n.text.length), Number.POSITIVE_INFINITY);
  const scrub = (value: string): string => {
    if (names.length === 0 || value.length < shortest) {
      return value;
    }
    let lower: string | undefined;
    const ranges: Array<[number, number]> = [];
    for (const name of names) {
      if (name.text.length > value.length) {
        continue;
      }
      let hay = value;
      if (name.ci) {
        lower ??= asciiLower(value);
        hay = lower;
      }
      let from = 0;
      for (;;) {
        const at = hay.indexOf(name.text, from);
        if (at < 0) {
          break;
        }
        let end = at + name.text.length;
        const ok =
          name.kind === 'host'
            ? hostPrevOk(value, at) && hostNextOk(value, end)
            : name.kind === 'url'
              ? !isAlnum(value[at - 1]) && hostNextOk(value, end)
              : name.kind === 'path'
                ? pathNextOk(value, end)
                : true;
        if (ok) {
          while (name.b64 && value[end] === '=' && end - at < name.text.length + 2) {
            end += 1;
          }
          ranges.push([at, end]);
          from = end;
        } else {
          from = at + 1;
        }
      }
    }
    if (ranges.length === 0) {
      return value;
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const parts: string[] = [];
    let cursor = 0;
    let [start, stop] = ranges[0] as [number, number];
    const flush = () => {
      parts.push(value.slice(cursor, start), '[endpoint]');
      cursor = stop;
    };
    for (const [s, e] of ranges.slice(1)) {
      if (s <= stop) {
        stop = Math.max(stop, e);
      } else {
        flush();
        [start, stop] = [s, e];
      }
    }
    flush();
    parts.push(value.slice(cursor));
    return parts.join('');
  };
  if (scrubbers.size >= 32) {
    scrubbers.clear();
  }
  scrubbers.set(url, scrub);
  return scrub;
}

/** `text` with the connection's own endpoint names replaced by `[endpoint]`; see {@link endpointNames}. */
export function scrubEndpointNames(text: string, url: string): string {
  return endpointScrubber(url)(text);
}

/**
 * A tool result of a plugin's mapped server with that connection's own endpoint replaced by
 * `[endpoint]` in every string of it: each field of each content block (`text`, `_meta`,
 * `annotations`, a resource's `uri` and `text`), `structuredContent`, `_meta`, any other top-level
 * field, and object keys. Only the base64 payload (`data`, `blob`) of a NON-text block, and of its
 * embedded `resource`, is left alone; the same key elsewhere (in `structuredContent`, say) is data
 * like any other. Any other URL, address or `host:port` is data the agent asked for and is left
 * alone, unless the result is an error and `options.wide` is given: errors take the wider scrub the
 * relay's own errors take (IP literals and host:port too).
 *
 * Keys that collide once rewritten are kept apart by a `_2`, `_3` suffix; a subtree deeper than
 * {@link MAX_SCRUB_DEPTH} is replaced by `'[truncated]'`, never returned raw. When scrubbing changed
 * `structuredContent` it is dropped from the result: the harness's client validates it against the
 * tool's output schema (`pattern`, `format: uri` ...), which a rewritten string can fail, and the
 * scrubbed `content` blocks remain the model-visible payload. Unchanged, it is left as it is.
 * Fails closed: a result that cannot be walked is replaced by a generic error result.
 */
export function scrubResultEndpoint(
  result: CallToolResult,
  url: string,
  options: { wide?: (text: string) => string } = {}
): CallToolResult {
  try {
    const endpoint = endpointScrubber(url);
    const wide = result.isError === true ? options.wide : undefined;
    const text = (value: string) => (wide ? wide(endpoint(value)) : endpoint(value));
    let changed = false;
    const str = (value: string) => {
      const out = text(value);
      if (out !== value) {
        changed = true;
      }
      return out;
    };
    const walk = (value: unknown, depth: number, skipEncoded: boolean): unknown => {
      if (typeof value === 'string') {
        return str(value);
      }
      if (value === null || typeof value !== 'object') {
        return value;
      }
      if (depth > MAX_SCRUB_DEPTH) {
        changed = true;
        return '[truncated]';
      }
      if (Array.isArray(value)) {
        return value.map((v) => walk(v, depth + 1, false));
      }
      const used = new Set<string>();
      const entries: Array<[string, unknown]> = [];
      for (const [key, v] of Object.entries(value)) {
        let outKey = str(key);
        for (let n = 2; used.has(outKey); n += 1) {
          outKey = `${str(key)}_${n}`;
        }
        used.add(outKey);
        entries.push([
          outKey,
          skipEncoded && ENCODED_FIELDS.has(key) && typeof v === 'string'
            ? v
            : walk(v, depth + 1, skipEncoded && key === 'resource'),
        ]);
      }
      return Object.fromEntries(entries);
    };
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result)) {
      if (key === 'content' && Array.isArray(value)) {
        out[key] = value.map((block) =>
          walk(
            block,
            1,
            block !== null &&
              typeof block === 'object' &&
              (block as { type?: unknown }).type !== 'text'
          )
        );
      } else if (key === 'structuredContent') {
        const before: boolean = changed;
        changed = false;
        const walked = walk(value, 0, false);
        if (!changed) {
          out[key] = walked;
        }
        changed = changed || before;
      } else {
        out[key] = walk(value, 0, false);
      }
    }
    return out as CallToolResult;
  } catch {
    return failure('The tool result could not be processed.');
  }
}

/**
 * Opens the relay for `target`, or `null` when the server cannot be reached or
 * listed — never throws: as with the Mastra binding, an unreachable MCP server
 * leaves the agent with its workspace tools rather than failing the activity.
 * The trace records `mcp.tools_loaded`, `mcp.invalid_ref` or `mcp.connect_failed`.
 */
export async function openMcpRelay(
  target: McpConnectionTarget,
  tracer?: McpTracer,
  options: {
    /**
     * Applied after the connection's allowlist: a tool it refuses is neither offered nor
     * callable. For a caller that must fit the tool names into a naming rule of its own.
     */
    acceptTool?: (name: string) => boolean;
    /**
     * For a relay that is not the Agent's own connection (a plugin's mapped server): its endpoint
     * is not the audience's to read, and the server's text is not the operator's. The audit log
     * names `label` in place of the URL, `scrub` is applied to every error the model or a trace
     * sees, and the server's own `instructions` are not offered to the harness at all: they are
     * third-party text from a server the plugin's author chose, and would otherwise go into the
     * system prompt unscreened. The tools' descriptions and schema text are neutralised
     * ({@link neutraliseThirdPartyTools}): stripped of control characters, length-capped and
     * screened for injection.
     */
    thirdParty?: { label: string; scrub: (text: string) => string };
  } = {}
): Promise<McpRelay | null> {
  const listTimeoutMs = target.listTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  const callTimeoutMs = target.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const allowPrivate = target.allowPrivateNetwork === true;
  const start = Date.now();

  const url = parseMcpServerRef(target.url, allowPrivate);
  if (!url) {
    tracer?.addActivityEvent({
      error: `mcpServerRef must be an http(s) URL the worker may reach: ${target.url}`,
      inputJson: { mcpServerRef: target.url },
      name: 'mcp.invalid_ref',
    });
    return null;
  }
  const fetch =
    target.bearerToken || target.headers?.length
      ? bearerFetch(url, target.bearerToken, originScopedFetch(url, allowPrivate), target.headers)
      : guardedMcpFetch(url, allowPrivate);

  let client: Client;
  let tools: Tool[];
  let skipped: string[];
  try {
    client = await connect(url, fetch, listTimeoutMs);
    const listed = await withTimeout(
      listAllTools(client),
      listTimeoutMs,
      `MCP tool listing from ${url}`
    );
    // The connection's allowlist applies here, before anything is offered: a tool outside it is
    // absent from the list the harness sees, and `callTool` refuses any name that is not in it.
    const split = selectAllowedMcpTools(
      listed.map((t) => t.name),
      target.allowedTools
    );
    const kept = new Set(split.kept);
    const offered = listed.filter(
      (t) => kept.has(t.name) && (options.acceptTool?.(t.name) ?? true)
    );
    // A plugin's server is third-party: its tool text is neutralised before the harness sees it.
    tools = options.thirdParty ? await neutraliseThirdPartyTools(offered) : offered;
    skipped = split.skipped;
  } catch (err) {
    tracer?.addActivityEvent({
      durationMs: Date.now() - start,
      error: scrubToken(getErrorMessage(err), target.bearerToken),
      inputJson: { mcpServerRef: target.url },
      name: 'mcp.connect_failed',
    });
    return null;
  }

  const instructions = options.thirdParty ? undefined : client.getInstructions();
  const scrubbed = (text: string) => (options.thirdParty ? options.thirdParty.scrub(text) : text);
  const callTool = async (
    name: string,
    args: Record<string, unknown> | undefined
  ): Promise<CallToolResult> => {
    const offered = tools.find((t) => t.name === name);
    if (!offered) {
      return failure(`The MCP tool '${name}' is not offered by this connection.`);
    }
    const guarded = target.approval;
    if (guarded) {
      // An orchestration's run: a write waits for the launcher, and a refusal is an error result.
      const outcome = await guarded.run(
        { annotations: offered.annotations, args, toolName: name },
        () => invoke(offered, name, args)
      );
      return outcome.ran ? outcome.value : failure(scrubbed(outcome.message));
    }
    return invoke(offered, name, args);
  };
  const invoke = async (
    offered: Tool,
    name: string,
    args: Record<string, unknown> | undefined
  ): Promise<CallToolResult> => {
    // Reads are not effects: only a call the server did not declare read-only is recorded.
    const record = (status: 'DONE' | 'FAILED', error?: unknown) =>
      mcpToolIsReadOnly(offered)
        ? Promise.resolve()
        : recordEffect({
            action: name,
            error,
            input: args,
            kind: 'MCP_TOOL',
            status,
            target: name,
            via: 'harness_relay',
          });
    auditLog(
      `[mcp:audit] server=${options.thirdParty?.label ?? url} tool=${name} args=${redactString(JSON.stringify(args ?? {}).slice(0, 2_000))} via=harness`
    );
    try {
      const raw = (await withTimeout(
        client.callTool({ arguments: args, name }),
        callTimeoutMs,
        `MCP tool call '${name}'`
      )) as CallToolResult;
      // A plugin's server never shows the model the connection's own endpoint, errors or not.
      const result = options.thirdParty
        ? scrubResultEndpoint(
            raw,
            target.url,
            // An error result takes the wider scrub, as the relay's own errors do.
            raw.isError ? { wide: options.thirdParty.scrub } : undefined
          )
        : raw;
      await record(
        result.isError ? 'FAILED' : 'DONE',
        result.isError ? 'tool reported an error' : undefined
      );
      if (target.scanResults !== true && target.approval === undefined) {
        return result;
      }
      const screened = await screenMcpResult(result, name, tracer);
      return screened.blocked
        ? failure(scrubbed(screened.message))
        : (screened.result as CallToolResult);
    } catch (err) {
      const message = scrubbed(scrubToken(getErrorMessage(err), target.bearerToken));
      await record('FAILED', message);
      return failure(message);
    }
  };
  const createServer = () => {
    const server = new McpServer(
      { name: 'auto-swe-relay', version: '1.0.0' },
      { capabilities: { tools: {} }, instructions }
    );
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      callTool(request.params.name, request.params.arguments)
    );
    return server;
  };

  if (skipped.length > 0) {
    tracer?.addActivityEvent({
      inputJson: { mcpServerRef: target.url },
      name: 'mcp.tools_skipped',
      outputJson: { reason: 'not_allowlisted', skipped, via: 'harness' },
    });
  }
  tracer?.addActivityEvent({
    durationMs: Date.now() - start,
    inputJson: { mcpServerRef: target.url },
    name: 'mcp.tools_loaded',
    outputJson: { count: tools.length, tools: tools.map((t) => t.name), via: 'harness' },
  });

  let closed: Promise<void> | undefined;
  return {
    callTimeoutMs,
    callTool,
    close: () => {
      closed ??= client.close().catch(() => undefined);
      return closed;
    },
    createServer,
    tools,
  };
}
