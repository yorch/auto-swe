# Plugin residual gaps — Implementation Plan

Workspace: branch `claude/happy-lovelace-r215ud`
Jira: N/A

Closes the bounded gaps still listed under `## Limitations` in
[`docs/harness-profiles.md`](../harness-profiles.md) and
[`docs/bundles.md`](../bundles.md) after the plugin MCP mapping work. Read both documents first.
The conventions of [`2026-11-17-plugins-plan.md`](./2026-11-17-plugins-plan.md) apply unchanged.

## Decisions

1. **A run that cannot pin its mapped MCP connections relays nothing.** When the pin cannot be read
   (already so), cannot be written at first use, belongs to another execution, names a different
   version, or the run has no run row, plugin MCP servers are not relayed for that activity and
   `agent.plugin_mcp_skipped` records a fixed reason. The live set is never used as a fallback.
2. **A successful result from a plugin's mapped server has that connection's own endpoint
   scrubbed**: the exact URL and the host of the mapped connection become `[endpoint]`. Other URLs,
   IP literals and `host:port` text in a result are data the agent asked for and are not touched.
   Errors, refusals and screening messages keep their existing, wider scrub.
3. **Bundle export reports a ref it cannot carry.** `exportBundle` returns `{ manifest, warnings }`;
   the export route answers `{ data: manifest, warnings }` and the CLI prints each warning to stderr.
   A `warnings` array is always present (possibly empty).
4. **Relays opened once per activity is the design, not a gap**: an activity is the boundary a
   relay cannot outlive. The documents say so as a design note instead of a limitation.
5. **Real-transport coverage.** The relay is exercised against a real in-process MCP server over the
   real transport (runnable without Docker), and the Docker suite gains one case that mirrors its
   existing relayed-connection case for a mapped plugin server.
6. The `<fixing commit SHA>` of the plugin MCP mapping entry in `docs/upgrade-notes.md` becomes the
   squash commit `ce802844`.

## Tasks

- [ ] Task 1: worker — fail closed when the pin cannot be established; scrub the mapped connection's own endpoint from successful results
- [ ] Task 2: gateway and CLI — export warnings
- [ ] Task 3: tests — real-transport relay test, Docker case
- [ ] Task 4: docs, upgrade-note key
- [ ] Task 5: adversarial review, fixes, gates
