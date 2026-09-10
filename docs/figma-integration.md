# Figma Integration

Design context for UI work, so a frontend ticket is implemented *from the design* rather than
guessed from prose. Two independent paths, at different altitudes:

| Path | When it applies | What it gives |
|---|---|---|
| **Agent-time (MCP)** | An Agent has the `'mcp'` tool key and an `mcp` Connection pointing at Figma | Interactive, high-fidelity — the agent pulls exactly the node it needs, mid-reasoning |
| **Submit-time (REST)** | Figma is enabled and a work request references a Figma URL | Eager and universal — every agent in the run sees a compact design summary, with no MCP dependency |

They degrade independently: submit-time enrichment guarantees a baseline everywhere, and the MCP
path lets capable agents go deeper on demand.

The original RFC, including the later phases that were scoped but not built, is preserved at
[`history/figma-integration-rfc.md`](./history/figma-integration-rfc.md).

---

## 1. Agent-time reads via MCP

This path is configuration, not code — it reuses the MCP integration end to end.

1. **Create a Figma `mcp` Connection** at `/studio/mcp` with the Figma Dev Mode MCP
   endpoint URL. It is stored as an ordinary `Connection{ type: 'mcp', config: { url } }`; the
   connection layer already accepts any HTTP(S) MCP server.
2. **Bind it to the implementer and reviewer Agents** at `/studio/agents/library`: add `'mcp'` to the
   Agent's `toolKeys` and set `mcpConnectionId`. `resolveAgentMcpUrl` binds Figma's tools at run
   time through `buildImplementerForActivity` and the review network.
3. **The `design-fidelity` skill** does the steering. It tells the implementer to fetch the relevant
   frame first when a ticket references a design; to match spacing, color, typography, and component
   structure to the design's variables and tokens rather than inventing values; to prefer existing
   design-system components; and to call out ambiguity instead of guessing. A companion reviewer
   note flags visual drift from the referenced design.

> **Reachability is the operational catch.** Figma's Dev Mode MCP server has historically run as a
> *local* endpoint tied to the desktop app (`http://127.0.0.1:3845/…`) and may require a seat. The
> worker runs in a container and must be able to reach whatever endpoint is configured — verify
> egress before relying on this path. Where only a local endpoint is available, submit-time
> enrichment is the primary mechanism.

Figma frame payloads can be large. The skill steers the agent toward targeted node fetches, and
`loadMcpTools`' per-call timeout applies; watch `mcp:audit` volume on early runs.

---

## 2. Submit-time design context

Mirrors the tracker and knowledge-base enrichment exactly.

- **`FigmaConfig`** — a singleton table (`id = 'default'`) with `enabled`, an encrypted `apiToken`,
  and a `maxNodes` cap. Managed at `/studio/integrations → Figma`, resolved by `resolveFigmaConfig()`.
- **`FigmaProvider`** — a REST client behind `createFigmaDesignProvider`, using `X-Figma-Token`
  against the files, nodes, and local-variables endpoints.
- **`extractFigmaRefs`** pulls `figma.com/(file|design)/…` URLs out of ticket and description text.
- **`enrichWithDesignData`** runs at work-request submit: when Figma is enabled and a reference is
  found, it fetches a compact summary — frame names, layout summary, resolved variables and tokens —
  and writes it to `ContextSnapshot.rawDesign`.
- The worker injects a compact design block into the implementer prompt, and the snapshot is visible
  in the run's context view alongside ticket and documentation data.

Enrichment is **best-effort and never blocking**: a Figma failure logs and moves on, exactly like
the tracker and knowledge-base connectors. Like them, a self-hosted base URL on a private address
requires the explicit `allowPrivateNetwork` opt-in before the SSRF guard will accept it.

---

## 3. Not built

Design-token synchronization (keeping a repo's token files in step with Figma variables) and a
dedicated design-QA review agent that renders the implemented UI and compares it to the design were
scoped in the RFC and deliberately left unbuilt.
