# Plugin gaps — Implementation Plan

Workspace: branch `claude/happy-lovelace-r215ud`
Jira: N/A

Closes the known gaps listed under `## Limitations` in [`docs/harness-profiles.md`](../harness-profiles.md)
that have a bounded fix. Read that document first: it describes the plugin lifecycle as built.

Conventions for every task: the ones in [`2026-11-17-plugins-plan.md`](./2026-11-17-plugins-plan.md)
apply unchanged (present-tense docs, `## Limitations` for gaps, assistant policy entry per route,
guarded fetch only, no `prisma format`, hand-check migrations, never skip or weaken a test).

## Decisions

1. **Plugin MCP servers (admin mapping, relayed at run time).** A plugin's declared HTTP MCP servers
   (`.mcp.json` and inline `mcpServers` of `plugin.json`) are mapped by a platform ADMIN, per plugin
   and server name, to an existing `mcp` Connection. At run time the worker relays the mapped
   connections' tools to agents bound to that plugin, beside the agent's own connection, with every
   existing connection control (tool allowlist, result screening, audit, the connection's own access
   rules) unchanged. The harness still never loads a plugin's `.mcp.json` (`strictMcpConfig`).
   - A mapping binds only a Connection the run could already bind as an `Agent.mcpConnectionId`; the
     run-time check repeats the agent binding's access rule and skips an unusable mapping with an
     `agent.plugin_mcp_skipped` event (fixed reason strings) instead of failing the run.
   - stdio and sse servers stay unsupported and are listed as such.
2. **Marketplace-entry approval projects skills** for runtimes other than `claude-code`, like the
   folder approval, update accept and bundle install do.
3. **Bundle plugin references carry an optional `ref`** (branch or tag) that becomes the created
   profile's ref; absent keeps `HEAD`. Absent hashes as before.
4. **Marketplace entries on approved GitHub hosts.** A `github` entry source resolves on the
   marketplace repository's own host unless it names another host on the approved repository host
   list; the existing host policy, SSRF guard and platform-credential rules apply.
5. **Large marketplace repositories.** A truncated recursive tree listing falls back to listing only
   the directories the read needs, instead of refusing.
6. **`strict: false` entries.** An entry with no `plugin.json` gets a synthesized
   `.claude-plugin/plugin.json` from the entry's own fields; the synthesized file is part of the
   hashed snapshot.
7. **Hook sources in any markdown file.** With hooks off, every `.md` file of a plugin (not only the
   skill and command locations) is read for `hooks` frontmatter and rewritten without it; an
   unparseable frontmatter that mentions `hooks` makes the plugin unreadable. The hooks diff and the
   scanner cover the same set.
8. The explorer narrative cards for plugins are updated to the current behaviour; the review
   attestation stays a human step.

## Tasks

- [ ] Task 1: Schema `PluginMcpMapping`, migration, shared extraction of declared servers (inline and file), types
- [ ] Task 2: Worker relay of mapped connections
- [ ] Task 3: Gateway mapping routes, detail DTO, audit, assistant policy
- [ ] Task 4: Web mapping UI
- [ ] Task 5: Hook sources in any markdown file
- [ ] Task 6: Marketplace: skill projection on approval, approved GitHub hosts, truncated trees, `strict: false`
- [ ] Task 7: Bundle plugin `ref`
- [ ] Task 8: Docs verified against code, upgrade-note key, explorer narrative, `## Limitations`
- [ ] Task 9: Adversarial review, fixes, gates
