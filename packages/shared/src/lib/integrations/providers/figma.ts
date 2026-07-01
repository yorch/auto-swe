import type { FigmaDesignProvider } from '../figmaDesign.js';
import type { ResolvedFigmaConfig } from '../registry.js';
import type {
  FigmaDesignRef,
  FigmaDesignSummary,
  FigmaFetchOptions,
  FigmaNodeSummary,
} from '../types.js';

// ---- Figma REST API response shapes (minimal) ----

interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

interface FigmaPaint {
  type?: string;
  color?: FigmaColor;
  visible?: boolean;
}

interface FigmaTypeStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
}

interface FigmaNode {
  id: string;
  name?: string;
  type?: string;
  characters?: string;
  fills?: FigmaPaint[];
  style?: FigmaTypeStyle;
  children?: FigmaNode[];
}

interface FigmaNodesResponse {
  name?: string;
  nodes?: Record<string, { document?: FigmaNode } | undefined>;
}

interface FigmaFileResponse {
  name?: string;
  document?: FigmaNode;
}

interface FigmaVariablesResponse {
  meta?: {
    variables?: Record<
      string,
      { name?: string; resolvedType?: string; valuesByMode?: Record<string, unknown> } | undefined
    >;
  };
}

// ---- helpers ----

const CHILD_NAME_CAP = 24;
const TEXT_CAP = 40;
const TEXT_LEN_CAP = 200;
const TOKEN_CAP = 64;
const WALK_DEPTH = 3;

function rgbaToHex(c: FigmaColor): string {
  const to255 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const hex = (v: number) => to255(v).toString(16).padStart(2, '0');
  const base = `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
  return c.a !== undefined && c.a < 1 ? `${base}${hex(c.a)}` : base;
}

/// Walk a node subtree (bounded depth), collecting a compact summary plus any
/// color/typography tokens encountered. Mutates the shared `texts`/`tokens`
/// accumulators so caps apply across the whole node, not per-level.
function walkNode(
  node: FigmaNode,
  depth: number,
  acc: { texts: string[]; tokens: Map<string, string> }
): void {
  if (node.type === 'TEXT' && node.characters && acc.texts.length < TEXT_CAP) {
    const trimmed = node.characters.trim().slice(0, TEXT_LEN_CAP);
    if (trimmed) {
      acc.texts.push(trimmed);
    }
  }
  for (const fill of node.fills ?? []) {
    if (
      fill.visible !== false &&
      fill.type === 'SOLID' &&
      fill.color &&
      acc.tokens.size < TOKEN_CAP
    ) {
      const hex = rgbaToHex(fill.color);
      acc.tokens.set(`color:${hex}`, hex);
    }
  }
  if (node.style?.fontFamily && acc.tokens.size < TOKEN_CAP) {
    const { fontFamily, fontSize, fontWeight } = node.style;
    const value = [fontFamily, fontWeight, fontSize ? `${fontSize}px` : null]
      .filter(Boolean)
      .join(' / ');
    acc.tokens.set(`font:${value}`, value);
  }
  if (depth < WALK_DEPTH) {
    for (const child of node.children ?? []) {
      walkNode(child, depth + 1, acc);
    }
  }
}

function summarizeNode(node: FigmaNode): {
  summary: FigmaNodeSummary;
  tokens: Map<string, string>;
} {
  const acc = { texts: [] as string[], tokens: new Map<string, string>() };
  walkNode(node, 0, acc);
  return {
    summary: {
      childNames: (node.children ?? [])
        .map((c) => c.name ?? '')
        .filter(Boolean)
        .slice(0, CHILD_NAME_CAP),
      id: node.id,
      name: node.name ?? '',
      texts: acc.texts,
      type: node.type ?? 'UNKNOWN',
    },
    tokens: acc.tokens,
  };
}

// ---- provider ----

export class FigmaProvider implements FigmaDesignProvider {
  private readonly baseUrl = 'https://api.figma.com/v1';

  constructor(private readonly config: ResolvedFigmaConfig) {}

  private async request<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'X-Figma-Token': this.config.apiToken ?? '' },
      method: 'GET',
    });
    if (!res.ok) {
      throw Object.assign(new Error(`Figma API error ${res.status}: ${await res.text()}`), {
        status: res.status,
      });
    }
    return res.json() as Promise<T>;
  }

  async fetchDesignSummary(
    ref: FigmaDesignRef,
    opts?: FigmaFetchOptions
  ): Promise<FigmaDesignSummary | null> {
    const maxNodes = opts?.maxNodes ?? this.config.maxNodes ?? 12;
    try {
      const documents: FigmaNode[] = [];
      let fileName: string | undefined;
      let truncated = false;

      if (ref.nodeIds.length > 0) {
        const requested = ref.nodeIds.slice(0, maxNodes);
        const ids = requested.map(encodeURIComponent).join(',');
        const resp = await this.request<FigmaNodesResponse>(
          `/files/${encodeURIComponent(ref.fileKey)}/nodes?ids=${ids}`
        );
        fileName = resp.name;
        for (const id of requested) {
          const doc = resp.nodes?.[id]?.document;
          if (doc) {
            documents.push(doc);
          }
        }
        // Truncated if we capped the id list, or if the response omitted some
        // requested nodes (e.g. a deleted/inaccessible node id).
        if (ref.nodeIds.length > maxNodes || documents.length < requested.length) {
          truncated = true;
        }
      } else {
        // Whole-file reference: fetch shallow and summarize top-level frames.
        const resp = await this.request<FigmaFileResponse>(
          `/files/${encodeURIComponent(ref.fileKey)}?depth=2`
        );
        fileName = resp.name;
        const topLevel = (resp.document?.children ?? []).flatMap((page) => page.children ?? []);
        documents.push(...topLevel.slice(0, maxNodes));
        if (topLevel.length > maxNodes) {
          truncated = true;
        }
      }

      if (documents.length === 0) {
        return null;
      }

      const nodes: FigmaNodeSummary[] = [];
      const tokens = new Map<string, string>();
      for (const doc of documents) {
        const { summary, tokens: nodeTokens } = summarizeNode(doc);
        nodes.push(summary);
        for (const [k, v] of nodeTokens) {
          tokens.set(k, v);
        }
      }

      // Best-effort design variables (Figma Variables are Enterprise-gated and
      // commonly 403 — never let it sink the summary).
      const variableTokens = await this.fetchVariables(ref.fileKey).catch(() => []);

      // Node-derived color/typography tokens come first: they are tied to the
      // referenced frames and must not be crowded out of the cap by a large
      // Enterprise variable set.
      const nodeTokens = [...tokens.entries()].map(([name, value]) => ({ name, value }));
      return {
        fileKey: ref.fileKey,
        fileName,
        nodes,
        tokens: [...nodeTokens, ...variableTokens].slice(0, TOKEN_CAP),
        truncated: truncated || undefined,
        url: ref.url,
      };
    } catch (err) {
      opts?.log?.warn({ err, fileKey: ref.fileKey }, 'Figma design summary fetch failed');
      return null;
    }
  }

  private async fetchVariables(fileKey: string): Promise<{ name: string; value: string }[]> {
    const resp = await this.request<FigmaVariablesResponse>(
      `/files/${encodeURIComponent(fileKey)}/variables/local`
    );
    const out: { name: string; value: string }[] = [];
    for (const v of Object.values(resp.meta?.variables ?? {})) {
      if (!v?.name) {
        continue;
      }
      const firstMode = Object.values(v.valuesByMode ?? {})[0];
      out.push({
        name: `var:${v.name}`,
        value: firstMode !== undefined ? JSON.stringify(firstMode) : (v.resolvedType ?? ''),
      });
      if (out.length >= TOKEN_CAP) {
        break;
      }
    }
    return out;
  }
}
