import type { FigmaDesignRef, FigmaDesignSummary, FigmaFetchOptions } from './types.js';

// Re-export the design summary shape so consumers (e.g. the worker) can import
// it from this already-exported module without a duplicate local declaration.
export type { FigmaDesignRef, FigmaDesignSummary, FigmaNodeSummary } from './types.js';

/// Reads design source-of-truth from Figma. Read-only — the connector never
/// writes to Figma (consume design truth, never push). Always best-effort:
/// implementations return null rather than throwing so design enrichment can
/// never block a work request.
export interface FigmaDesignProvider {
  fetchDesignSummary(
    ref: FigmaDesignRef,
    opts?: FigmaFetchOptions
  ): Promise<FigmaDesignSummary | null>;
}

// Matches both Figma URL shapes, with or without the human-readable slug:
//   https://www.figma.com/file/<key>/<slug>?node-id=1-23
//   https://www.figma.com/design/<key>?node-id=1%3A23
// The tail group accepts either a `/slug…` path or an immediate `?query`, so a
// slug-less link's `node-id` is still captured in the match.
const FIGMA_URL_RE =
  /https?:\/\/(?:www\.)?figma\.com\/(?:file|design)\/([A-Za-z0-9]+)(?:[/?][^\s)"'<>]*)?/g;
const NODE_ID_RE = /[?&]node-id=([^&\s)"'<>]+)/;

/// Normalize a Figma `node-id` to the API form: the URL/anchor form uses `-`
/// (e.g. `1-23`) while the REST API expects `:` (e.g. `1:23`). Handles
/// percent-encoded `%3A` too. Never throws on a malformed percent sequence —
/// falls back to the raw value so one bad link can't abort ref extraction.
export function normalizeFigmaNodeId(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding — use the raw value as-is.
  }
  return decoded.replace(/-/g, ':');
}

/// Pull Figma design references out of free-form text (a ticket description,
/// title, or documentation body). Pure and dependency-free. Deduplicates by
/// file key, merging node ids across multiple links to the same file.
export function extractFigmaRefs(text: string | null | undefined): FigmaDesignRef[] {
  if (!text) {
    return [];
  }
  const byFile = new Map<string, FigmaDesignRef>();
  for (const match of text.matchAll(FIGMA_URL_RE)) {
    const fileKey = match[1];
    if (!fileKey) {
      continue;
    }
    const url = match[0];
    const nodeMatch = url.match(NODE_ID_RE);
    const nodeId = nodeMatch ? normalizeFigmaNodeId(nodeMatch[1]) : null;

    const existing = byFile.get(fileKey);
    if (existing) {
      if (nodeId && !existing.nodeIds.includes(nodeId)) {
        existing.nodeIds.push(nodeId);
      }
    } else {
      byFile.set(fileKey, {
        fileKey,
        nodeIds: nodeId ? [nodeId] : [],
        url,
      });
    }
  }
  return [...byFile.values()];
}
