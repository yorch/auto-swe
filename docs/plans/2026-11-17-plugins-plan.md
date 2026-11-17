# Plugins (Claude Code plugin lifecycle) — Implementation Plan

Workspace: branch `claude/happy-lovelace-r215ud`
Jira: N/A

A plugin is a Claude Code plugin directory (`.claude-plugin/plugin.json`, skills, commands, agents,
hooks, scripts, `.mcp.json`). The platform already approves such directories as **harness
profiles** ([harness-profiles.md](../harness-profiles.md)). This plan turns that into one plugin
lifecycle: marketplace discovery, update tracking, a hook switch, several plugins per agent, team
enablement, bundle carriage, and skill projection for runtimes other than `claude-code`.

It ships as one change (one pull request). The tasks below are ordered by dependency and each is
its own commit.

Conventions for every task:

- Read `CLAUDE.md` first. Docs describe the system in present tense (§5): no status prose, no PR
  numbers, no phase labels in living docs. Known gaps go in the feature doc's `## Limitations`.
- A schema task reads the `prisma-pgvector-hnsw` skill first and hand-checks the generated
  migration for dropped HNSW or CHECK DDL. Use `findFirst` + conditional create, never `upsert`,
  for rows with partial unique indexes.
- A new gateway route gets an entry in `packages/gateway/src/lib/assistantPolicy.ts`
  (`read`, `confirm`, `never`). Writes to plugins are `never`.
- A new route for an operator-supplied URL fetches only through the existing guarded fetcher
  (`shared/src/lib/skillSource/`, `shared/src/lib/harnessProfile/`); never a bare `fetch`.
- A new `*.pg.test.ts` is named on a `yarn test` line of a `ci.yml` step that sets its flag.
- Every `fetch` under the integration directories states `redirect`.
- Tests are co-located. Mock Prisma for unit tests.
- A change an operator must act on adds an entry to `docs/upgrade-notes.md` in the same commit.
- Before each commit run the gates in `CLAUDE.md` §5 that apply from the worktree: `yarn typecheck`,
  `yarn test` for the touched files, `yarn biome check` on explicit directories, `yarn docs:check`,
  `yarn invariants:check`. The full set runs once at the end.

## Decisions (settled with the product owner)

1. **Goal.** Reuse the Claude Code ecosystem: the Claude Code plugin and `marketplace.json` formats
   are the interchange format.
2. **Who.** A platform ADMIN approves a plugin (global). A team admin enables approved plugins for
   their team and binds them on their team's agent overrides.
3. **Hooks.** One boolean per plugin, `hooksEnabled`, decided by a platform ADMIN at approval and
   applied **when the plugin is written into the run container**, never in the stored snapshot.
   - Off: hook configs are not written (`hooks/hooks.json`, inline `hooks` in `plugin.json`, any
     file `plugin.json` names in `hooks`). A `hooks` path that leaves the plugin folder, is missing
     or is not valid JSON cannot be omitted reliably, so materialization **refuses the plugin**
     (non-retryable) when hooks are off and one is found.
   - Scripts and executable files are still written. The preview warns that the switch does not
     remove them.
   - Only a platform ADMIN changes `hooksEnabled`, in either direction; teams never. The change is
     audited and needs no new version.
   - An accepted update never turns hooks on. Off stays off. On with changed hook files requires a
     fresh `acknowledgeHookChanges: true` at accept, with a hooks diff in the preview.
   - Each run records an `agent.plugin_hooks` event naming each plugin and whether hooks were on.
4. **MCP.** HTTP server entries in a plugin's `.mcp.json` are listed as declared dependencies; an
   admin maps each to an existing `mcp` Connection. stdio entries are flagged unsupported. The
   harness keeps `strictMcpConfig`; the plugin's `.mcp.json` is still not loaded by the harness.
5. **Other runtimes.** Plugin skills are projected into `Skill` rows named `<plugin>:<skill>`.
   Commands, hooks and sub-agents apply only on `claude-code`. A run on another runtime records an
   `agent.plugin_partial` event naming what was skipped.
6. **Trust.** Sha pin plus admin review. No signature requirement.
7. **Commands.** Stay `claude-code` only. No command-to-template mapping.
8. **Enablement.** A `PluginEnablement` row `(profileId, teamId)` gates team binding. The worker
   fails closed when an agent bound to a plugin runs for a team that has no enablement, unless the
   binding is on a platform-wide agent set by an ADMIN.
9. **Revocation.** Disabling a plugin or removing an enablement fails **new** runs closed with an
   error naming the plugin. Runs in flight keep their pinned snapshot. The library page lists
   stranded agents.
10. **Cardinality.** An agent binds a **list** of plugins. `Agent.harnessProfile` (text) is replaced
    by `Agent.harnessProfiles` (text array) in **one migration**: the column is converted in place
    (`USING CASE WHEN harness_profile IS NULL THEN '{}' ELSE ARRAY[harness_profile] END`) and every
    reader changes in the same change. Binding two plugins whose `plugin.json` names collide is
    refused at bind time. Instructions are appended in list order, each behind its own provenance
    line; tool grants are the union.
11. **Projection.** Derived, namespaced, read-only skill rows. They start unverified, follow
    `skills.import.blockOnScanWarnings`, and are refused (not overwritten) on a hand edit.
12. **Marketplace.** A `MarketplaceSource` row (repo, ref, pinned sha) with the nightly sweep that
    `SkillSource` has. Entry sources accepted: a relative path inside the marketplace repo, or a
    GitHub / approved GitHub Enterprise repository. Other sources are listed but not installable.
    Approving an entry creates a single-plugin `HarnessProfile` pinned to that entry's commit.
13. **Bundles.** Schema v3. A bundle carries plugin **references**: source coordinates, an exact
    commit, the expected `contentHash`, the profile name and agent bindings by name. Install reads
    the commit with the guarded fetcher, requires the hash to match, and creates the profile with
    `hooksEnabled: false`. A mismatch refuses the install. Approval warnings are not skipped:
    install returns them and an `acknowledgeWarnings` flag is required.
14. **Update tracking.** `HarnessProfile` gets the fields `SkillSource` has (`latestSha`,
    `lastCheckedAt`, `lastError`, a tracking status). The same Temporal sweep visits profiles.
    `preview-update` compares against the **upstream** hash, so a hook switch never makes an
    unchanged plugin look changed.

## Data model changes

| Change | Notes |
|---|---|
| `Agent.harnessProfile` → `Agent.harnessProfiles String[] @default([])` | One migration; see decision 10 |
| `HarnessProfile.hooksEnabled Boolean @default(true)` | Existing profiles were approved with hooks on |
| `HarnessProfile` tracking fields: `latestSha`, `lastCheckedAt`, `lastError`, `trackStatus` | `OK`, `UPDATE_AVAILABLE`, `ERROR` |
| `HarnessProfile.marketplaceSourceId`, `marketplaceEntry` | Null for a profile added by folder |
| `MarketplaceSource` | host, owner, repo, path, ref, pinnedSha, latestSha, lastCheckedAt, lastError, status, createdById |
| `PluginEnablement` | `(profileId, teamId)` unique, `enabledById`, `createdAt`; cascades on team delete, restricts on profile |
| `Skill` projection columns | `pluginProfileId`, `pluginVersion` (null for ordinary skills) |

## Tasks

Run in order. Tasks marked (P) can run in parallel once Task 1 is done, because they touch disjoint
directories.

- [ ] Task 1: Schema and migration — list binding, `hooksEnabled`, tracking fields, `MarketplaceSource`, `PluginEnablement`, projection columns; shared types and every reader of `harnessProfile` compile.
- [ ] Task 2 (P): Worker — materializer applies `hooksEnabled`, writes several plugins, refuses unreadable hook paths, emits `agent.plugin_hooks` and `agent.plugin_partial`, enforces enablement and fail-closed revocation, resolves a list in the resolver, pins and runtime select.
- [ ] Task 3 (P): Gateway — profile service gets `hooksEnabled` (ADMIN), the sweep and `preview-update` against the upstream hash, the binding rules (list, collision refusal, enablement for team overrides), `PluginEnablement` routes, assistant policy entries.
- [ ] Task 4 (P): Gateway — marketplace source routes: add, list, check, catalog read, approve an entry as a profile, `.mcp.json` dependency mapping; sweep registration.
- [ ] Task 5 (P): Shared — bundle schema v3 with plugin references, SDK `definePlugin` reference helper and `validateBundle`, bundle install and preview fetch-and-verify, skill projection library.
- [ ] Task 6: Web — marketplace and plugin pages, hook switch, enablement, list binding in the agent form, stranded agents, projection badge.
- [ ] Task 7: Docs — `harness-profiles.md` becomes the plugin reference, `bundles.md`, `agents.md`, `architecture.md`, `upgrade-notes.md` (the deploy-order note for the column replacement), `README.md` map; `## Limitations` updated.
- [ ] Task 8: Adversarial review, fixes, and the full quality gates.

## Limitations to record in the docs

- Plugin MCP servers are mapped to Connections by an admin; stdio servers are unsupported.
- Commands are `claude-code` only.
- Hooks off still writes scripts.
- The column replacement has no old-column fallback: all gateway and worker instances must be
  upgraded together, and a worker on older code reading a migrated row sees no plugins.
