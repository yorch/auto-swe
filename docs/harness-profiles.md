# Plugins

> A plugin is a Claude Code plugin directory (commands, skills, sub-agents, hooks, scripts and
> `.mcp.json`). An administrator approves a plugin by reading it from a folder of a GitHub or GitHub
> Enterprise repository at an exact commit. The approved copy is stored as a **harness profile**: an
> immutable, content-hashed snapshot with its own name, hook switch and tracking state, which agents
> bind by name. This page covers how a plugin is discovered, read, reviewed, approved, tracked,
> enabled for a team, bound to an agent, written into a run container, and projected for runtimes
> other than Claude Code.

| Term | Meaning |
|---|---|
| Plugin | A Claude Code plugin directory: `.claude-plugin/plugin.json` and the folders it names. |
| Harness profile | The stored record of approved plugins: one folder of one or more plugins, optional instructions, its versions, and its settings (name, `hooksEnabled`, `status`, tracking). Agents bind profiles, not plugins. |
| Marketplace | A repository's `.claude-plugin/marketplace.json` catalog. An administrator approves one of its entries as a harness profile holding that single plugin. |
| Plugin enablement | A team's permission to bind a profile on its own (TEAM-scoped) agents: one row per profile and team. |

---

## 1. The profile folder

A profile is one folder of a repository (or the repository root):

```
<folder>/profile.json        required
<folder>/INSTRUCTIONS.md     optional; named by profile.json
<folder>/plugins/<p>/...     Claude Code plugin directories
```

`profile.json` is strict: a key this version does not know is an error.

| Field | Rule |
|---|---|
| `name` | Required. Starts with a letter or digit; letters, digits, `.`, `_`, `-`; 1 to 64 characters. Unique across profiles, compared case-insensitively. |
| `description` | Required, 1 to 1000 characters. |
| `instructions` | Optional relative `.md` path of a file in the folder, up to 100,000 bytes of UTF-8. |
| `plugins` | Optional list of up to 20 relative directories. Each must hold `.claude-plugin/plugin.json`, which must be a JSON object. |
| `tools` | Optional. Only `Skill` and `Agent` are accepted; anything else (`WebFetch`, `WebSearch`, `Bash`, ...) is a validation error. |

**Limits.** At most 500 files, 5 MB in total, 1 MB per file.

**Refused, never skipped.** A folder is refused outright (a validation error, with the reason
beside a display-safe path) when it contains a symlink, a submodule, an absolute path, an empty,
`.` or `..` segment, a segment over 255 bytes or a path over 1024 bytes (UTF-8), a backslash, a
control or invisible character, a `.git` segment, or two paths that collide after Unicode
normalisation and case folding. A profile that silently lacked a file would not be the profile the
administrator reviewed.

**Every file is stored**, whatever its type: scripts and binaries too. Plugin `.mcp.json` files are
stored but never loaded at run time (section 9), and the preview says so.

A marketplace entry has no `profile.json`. Its plugin folder is read with the same rules and wrapped
into a single-plugin profile (section 11).

## 2. Snapshot identity

`contentHash` is the sha256 over the canonical, sorted list of `(path, mode, sha256(content))` plus
the parsed manifest. It does not depend on the order files arrive in or on the key order of the
manifest. It does not depend on the hook switch either: the switch is not part of the snapshot. A
version row is immutable: a change is recorded as another version.

## 3. Data model

| Model | Table | Purpose |
|---|---|---|
| `HarnessProfile` | `harness_profiles` | One approved profile: unique `name`, description, source (`host`, `owner`, `repo`, `path`, `ref`), `status` (`OK` or `DISABLED`), `latestVersion`, the hook switch `hooksEnabled`, the tracking fields (`latestSha`, `lastCheckedAt`, `lastError`, `trackStatus` of `OK`, `UPDATE_AVAILABLE` or `ERROR`) and, for a marketplace entry, `marketplaceSourceId` and `marketplaceEntry`. Global; never deleted. |
| `HarnessProfileVersion` | `harness_profile_versions` | One immutable snapshot: `version` (unique per profile), `commitSha`, `contentHash`, `manifest`, `fileIndex` (path, size, mode), `files` (a gzipped blob of every file), `scanWarnings`, `approvedById`. |
| `MarketplaceSource` | `marketplace_sources` | A tracked marketplace: source (`host`, `owner`, `repo`, `path`, `ref`), the `pinnedSha` its catalog is read at, `latestSha`, `lastCheckedAt`, `lastError` and `status` (`OK`, `UPDATE_AVAILABLE`, `ERROR` or `DISABLED`). Unique per `(host, owner, repo, path)`. |
| `PluginEnablement` | `plugin_enablements` | A team's enablement of one profile: unique `(profileId, teamId)` and `enabledById`. Deleting the team removes its rows; a profile with rows cannot be deleted. |
| `Agent.harnessProfiles` | `agents.harness_profiles` | Text array: the names of the profiles one Agent version is bound to, in binding order. It replaces the single `harness_profile` text column (section 8). |
| `Skill.pluginProfileId`, `Skill.pluginVersion` | `skills` | Set on a skill projected from a plugin (section 13); null for every other skill. |

The blob is packed and unpacked by `packFiles` / `unpackFiles`
(`packages/shared/src/lib/harnessProfile/snapshot.ts`). The decompressed bound is derived from the
file and path limits, so any snapshot that packs at approval unpacks. Unpacking re-checks every
path, the file count, per-file and total sizes and case-insensitive collisions.
`unpackAndVerify(blob, manifest, contentHash)` additionally recomputes the content hash and throws
on a mismatch; anything that materialises a snapshot uses it, so a blob altered after approval
(a changed file, an extra file, a flipped mode) is refused.

## 4. Reading a folder

The gateway reads a folder at approval and again at an update check (section 10).
`readProfileFolder` reuses the skill-source fetcher (see
[agents.md §6.6](./agents.md#66-external-skill-sources)): the repository host policy
(`github.com`, the instance's host, or a host in `github.repositoryHosts`), the SSRF guard and
connection pinning, manual redirects with the credential sent only to the API origin, the platform
credential only (never a user's), the shared rate floor, and fixed error strings that never echo
upstream text. It then:

1. Resolves the ref to an exact commit sha (or reads a named commit; `SHA_MOVED` when the ref no
   longer resolves to the commit a preview showed).
2. Lists the whole tree at that commit and refuses a truncated listing.
3. Checks the folder against the rules above using the listing alone, so a refused folder costs no
   file downloads.
4. Downloads every file by blob id, and checks that each blob's size and git object id match the
   listing. A tree entry whose size is not a non-negative safe integer is refused, and after the
   first failed download no further download is started.

Reviewing one file (`file` in a preview body) lists the tree in full but downloads only that blob,
with the same size and object id checks.

A fetch costs one request for the ref, one for the tree and one per file, so the request budget is
the file limit plus two and the whole fetch has a 120 second deadline. Repository-supplied text
shown to the administrator (paths, names) has control and invisible characters replaced.

## 5. Validation and scanning at approval

Validation is pure (`validateProfile`): it parses `profile.json`, checks the instructions file and
each plugin, applies the file rules, and computes the hash. It also produces warnings that never
block:

- plugin MCP servers are stored but never loaded at run time;
- auto-run sources are present: hooks, frontmatter hooks, monitors or LSP servers (each runs
  commands inside the run container; section 7 lists them);
- scripts are present;
- files have the executable bit set;
- files outside the instructions and plugins are stored but never used.

Scanning (`scanProfile`) is advisory and executes nothing. The platform's skill-content scanner runs
over the instructions and every plugin `.md`. The shell-command patterns run over every auto-run
command of section 7: the commands of `hooks/hooks.json`, of a plugin's inline `hooks`, and of any
hooks file a plugin's `plugin.json` names by path (a string, or an array mixing paths and inline
objects) inside the plugin folder; the `hooks` frontmatter of each skill and command; the commands of
monitors and LSP servers; and over every script, executable file and file that starts with `#!`.
A source that cannot be read, that names a path outside the plugin folder, or that names a missing
file adds a `hooks-not-scanned` warning: the commands it names would still run. A scan that could
not run every rule over everything adds a `scan-incomplete` warning rather than reading as clean.
Binary content and invalid UTF-8 prose are reported as not scanned.

For a marketplace entry, the approval warnings also list each MCP server the plugin declares
(section 11): one per unsupported server, and one for the HTTP servers the harness does not load.

**Approval needs acknowledgement.** When the preview has any warning (structure or scanner), create
and accept refuse with `409 WARNINGS_UNACKNOWLEDGED` unless the request carries
`acknowledgeWarnings: true`. The warnings are stored with the version.

**Approval is bound to the preview.** The preview returns `contentHash` and `warningsHash` (sha256
over the sorted, de-duplicated warnings). Create and accept require both, with the previewed `sha`.
The server re-reads the commit, recomputes both, and answers `409 PREVIEW_STALE` (with the fresh
values and warnings) when either differs, for example because scanner patterns changed, a pattern
was quarantined or the read differed. Acknowledgement therefore always covers the warnings the
administrator saw.

## 6. Trust model

- Approval (creating a profile, accepting a version, approving a marketplace entry, and installing
  a bundle's plugin references) is platform ADMIN only and platform-wide. A profile's hooks and
  scripts run commands in the run container, so who may bring one in is a platform decision.
- Only a platform ADMIN changes the hook switch. Team admins never do.
- A team admin enables approved plugins for their own team (section 12). Enablement lets a team bind
  a plugin on its own agents; it does not approve anything.
- Nothing is executed at preview or approval, and the worker never fetches a repository.
- The reviewed bytes are the stored bytes: a version is created from the commit the preview showed
  and the request fails with `SHA_MOVED` if the ref moved.
- The API never returns file content from list or get. The one exception is the explicit
  single-file review request.
- Profiles are not deleted, because an agent may reference one by name. A disabled profile takes no
  further version, cannot be enabled by a team, and is not bound to an agent or pinned by a run that
  starts after it is disabled.
- Every create, accept, status change, hook switch change, marketplace change and enablement change
  is written to the audit log under the entity types `HarnessProfile`, `MarketplaceSource` and
  `PluginEnablement`.

## 7. The hook switch

`HarnessProfile.hooksEnabled` decides whether a plugin's auto-run commands are written into the run
container. It is a boolean on the profile row, not on a version.

An **auto-run source** is any place where a plugin declares a command the host runs without the
model asking for it:

- `hooks/hooks.json`, the inline `hooks` of `plugin.json`, or a hooks file `plugin.json` names under
  `hooks`;
- the `hooks` key of the YAML frontmatter of a skill or command `.md`;
- monitors: `monitors/monitors.json`, and `monitors` or `experimental.monitors` in `plugin.json`;
- LSP servers: `.lsp.json`, and `lspServers` in `plugin.json`.

One module (`packages/shared/src/lib/harnessProfile/hookSources.ts`) lists these sources for the
approval warnings and scan, the hook diff and the switch, so all three cover the same sources.

A plugin's root-level `SKILL.md` is a skill, so its frontmatter is a source too. Each `skills` and
`commands` ref in `plugin.json` names a path inside the plugin folder. `.`, `./` and
`${CLAUDE_PLUGIN_ROOT}` (with or without a trailing slash) name the plugin root. A ref that leaves the
folder, or that matches no file in the snapshot, is an unreadable source.

Frontmatter is located as the harness loader locates it: after one byte-order mark is stripped, an
opener `---` followed by whitespace and a line break (JavaScript `\s`, which includes form feed,
vertical tab, NBSP, U+2028 and U+3000). A file is unreadable, never "no hooks", when its YAML does not
parse, when a key at any depth is the YAML merge key `<<`, or when the loader reads a `hooks` key the
module does not. Where the loader's closing `---` is not on a line of its own, the file is unreadable
only if the loader's text names `hooks`, a backslash or `<<`; otherwise the closing line is used. A
file with no closing line is read as having no frontmatter, unless the loader's text names `hooks`, a
backslash or `<<`, in which case it is unreadable.

- **Decided at approval.** The approval request must send `hooksEnabled` explicitly: a folder
  approval, a marketplace entry approval (both have no default) and a bundle install (which always
  creates the profile with hooks off) all answer with the choice made. Choosing hooks on at approval
  needs the same "reviewed" confirmation as the switch (section 16).
- **Changed by a platform ADMIN only.** `PATCH /harness-profiles/:name` with `hooksEnabled` sets
  it, is audited with the before and after values, and cuts no version. The stored snapshot and its
  content hash are unchanged, so an upstream check never sees a change from the switch alone. Turning
  hooks on needs `expectedVersion`, the latest version the admin reviewed: the route answers
  `400 HOOKS_EXPECTED_VERSION_REQUIRED` without it, and `409 HOOKS_VERSION_STALE` with
  `details.latestVersion` when the profile has a later version. The version check and the switch
  write are one compare-and-set in one transaction, so a version accepted in between also answers 409.
  Turning hooks off needs no version.
- **Applied when the plugin is written into the container, never in the snapshot.** With the switch
  off, the worker leaves out of each plugin every auto-run source above: `hooks/hooks.json`,
  `monitors/monitors.json` and `.lsp.json`, whatever they hold, and each file a `plugin.json` key
  names. `plugin.json` is written again without its `hooks`, `monitors`, `experimental.monitors` and
  `lspServers` keys and nothing else changed; each skill and command `.md` is written again without its
  `hooks` key, its body byte for byte. Scripts and executable files are still written. The dashboard
  says so beside the switch.
- **Unreadable sources.** A source the scan cannot read is kept with its reason. The reason appears on
  the source in the dashboard, in the hook diff (`unreadable` on the source or on a changed source), and
  as a `hooks-not-scanned` warning at approval. With the switch off, a plugin the worker cannot rewrite
  with certainty is refused without retry with `PROFILE_HOOKS_UNREADABLE`: a named path that leaves the
  plugin folder, or names a file that is not in the snapshot or is not valid UTF-8 JSON; a `plugin.json`
  that is missing, not valid JSON or not a JSON object; a plugin directory that is not a safe relative
  path; a skill or command ref that matches no file; or frontmatter that is unreadable, or cannot be
  edited without changing another key or the body. The plugin is not run. An unreadable default file
  (`hooks/hooks.json`, `monitors/monitors.json`, `.lsp.json`) is not a refusal, because it is left out.
- **The effective switch is the pinned value AND the live value.** A run takes the switch it
  pinned when it started (section 8), and the worker also reads the platform switch on each
  resolution. So a run never gains hooks: turning them on reaches only runs that start afterwards.
  An ADMIN turning them off applies to the next activity of a run in flight.
- **Updates never turn hooks on.** An accepted version leaves the switch as it is. The accept
  compares and sets the switch, so a switch change that races it answers `409
  HARNESS_PROFILE_CHANGED` and nothing is written. With the switch on, a version that adds, removes
  or changes any auto-run source (its commands, not only its file) needs `acknowledgeHookChanges:
  true` at accept; without it the answer is `409 HOOK_CHANGES_UNACKNOWLEDGED` with the diff. With the
  switch off, a hook change needs no acknowledgement, because those sources are not written.
- **The diff is shown before accept.** `preview-update` returns `hookChanges` (sources `added`,
  `removed` and `changed`, each with the commands it runs; a changed source lists the commands
  added and removed) and the profile's `hooksEnabled`. The dashboard renders the diff in the update
  dialog.
- **Recorded per run.** The first turn of each profiled Claude Code runtime emits an
  `agent.plugin_hooks` event for each profile. It carries the profile name and version, the
  effective `hooksEnabled`, the `pinned` value the run started with and the `live` platform value.

The switch covers every auto-run source listed above. A kind of auto-run source that the harness
starts from a plugin but that this list does not name is outside the switch (Limitations).

## 8. Binding plugins to an agent

`Agent.harnessProfiles` (text array) holds the **names** of approved profiles, in binding order. A
name is not a foreign key: profiles are never deleted and names never change, and a name that stops
resolving fails the run closed (below) rather than degrading.

**Scope of a binding.**

- **Set on the version itself.** It is not inherited along `inheritsModelFrom`: a fixer or persona
  never silently picks up the implementer's instructions and plugins. Bind each agent that should
  have plugins.
- **Who may set the list.** On a platform-wide (GLOBAL) agent, a platform ADMIN. On a team override,
  a team ADMIN may set the list, but only to profiles the team has enabled (section 12), and may
  remove names freely. The runtime stays platform ADMIN only. A platform ADMIN may also set a team
  override's list.
- **A team override starts with the platform-wide agent's profiles that the team has enabled.**
  Any it has not enabled are left out, and the response says which.
- **Claude Code runtime only.** The version's effective runtime (its own, else the one inherited
  along the platform-wide chain) must be `claude-code`; the same rule refuses moving a bound version
  off `claude-code`. The bulk model remap's `adaptRuntime` clears the list together with the
  runtime.

**Save checks.** The agent library refuses a save with a stable code and a message naming the
profile:

| Code | When |
|---|---|
| `PROFILE_RUNTIME_MISMATCH` | The effective runtime is not `claude-code` (checked on every save that names profiles). |
| `PROFILE_DUPLICATE` | A name is listed twice. |
| `PROFILE_NOT_FOUND` | A name is not an approved profile. |
| `PROFILE_DISABLED` | A name is a disabled profile. |
| `PROFILE_NAME_COLLISION` | Two profiles in the list hold a plugin with the same name (compared case-insensitively, from each profile's latest snapshot). |
| `PROFILE_NOT_ENABLED` | A TEAM-scoped version adds a profile its team has not enabled. |

The existence, status, collision and enablement checks run when the list is set or changed. A name
the version already carries is not re-checked for status or enablement, so a disabled or revoked
profile fails its runs closed and does not lock the rest of the agent. Restoring a version applies
the same checks.

**Order.** The profiles are applied in list order. Each profile's instructions are appended to the
system prompt behind its own provenance line; each profile's plugin directories are loaded in list
order; the built-in tool grants are the union of the profiles' `tools`.

**Resolution.** `resolveHarnessProfiles(agentKey, ctx, resolved?)` reads the names from the agent's
resolved version (the caller's own resolution when it passes one, so the profiles come from the same
Agent version as the model and tools of that run). For each name it picks the profile version: the
run's pin, else the profile's latest version (which must be OK). It returns the name, version,
commit, content hash, manifest and files, and verifies the stored snapshot against its content hash
before handing the files out.

**Run pin.** `WorkflowRun.harnessProfileVersions` maps each profile name to what the run was given:
a bare version number, or `{ version, hooks, verified }`. `hooks` is the platform switch at the pin.
`verified` lists the bindings whose TEAM-scoped binding of the plugin passed the enablement check
(section 12), each as `<teamId>:<agentKey>:<agentVersion>`. A verification therefore covers one team,
one agent and one agent version. An entry in the bare agent-key form matches no binding, so it exempts
nothing and its bindings are checked again. A reserved `__execution` key names the Temporal run id the map was taken for; a map
that names another execution is ignored, so a reused workflow id never inherits an earlier run's pins
or verified bindings.

At run start the worker pins the latest version of every OK profile bound to an agent the run can
resolve (same scope and agent-version pins as the runtime snapshot; channel turns too). A profile
bound on a TEAM-scoped version is pinned only when the run's team has enabled it. An agent with no
entry pins the version it first resolves with a compare-and-set on the whole map, so two activities
pinning different profiles keep both entries and an existing pin is never overwritten. A run that
pinned version N keeps N after a newer version is accepted or the profile is disabled. The pin
decides the version; it does not decide the permission (section 12).

**Fail closed.** An agent bound to a profile never runs without it. A non-retryable failure is raised
for each of these:

| Code | Cause |
|---|---|
| `PROFILE_UNAVAILABLE` | The profile does not exist; it is disabled and the run has not pinned it; or its pinned or latest version row is missing. |
| `PLUGIN_NOT_ENABLED` | The binding is on a TEAM-scoped version, the run has not verified that binding, and the run's team has no enablement for the plugin. Checked on every resolution, not only the first (section 12). |
| `PLUGIN_NAME_COLLISION` | Two profiles bound to the agent hold a plugin with the same name (refused at bind time too). |
| `PROFILE_INTEGRITY` | The snapshot no longer reproduces its content hash, or its instructions spell the provenance marker. |

**Other runtimes.** Mastra, Pi and any surface with no workspace run the agent without its plugins
(section 9).

**Bundles.** Export writes plugin references for the profiles that platform-wide agents bind
(section 14). Install adds bindings as further GLOBAL versions of the bundle's agents, under the same
collision rule.

## 9. What runs in the container

The Claude Code runtime is the one runtime that loads a profile. Every place a Claude Code runtime
is built for an agent bound to profiles resolves them first (`resolveProfileForRuntime`, which calls
`resolveHarnessProfiles` and so fails closed) and passes the verified snapshots to the runtime's
options: the implementer family (`buildImplementerTurnRunner`), agent runs (`runAgentTask`) and
`agent` nodes with a workspace (`runAgentNode`). Resolution happens before the container is created,
so a profile that cannot be resolved costs no clone.

**Where it goes.** Each profile's files land under
`/workspace/.harness/profiles/<first 12 hex of contentHash>/`, one directory per profile, beside the
harness binary and outside the checkout, so `git add -A` never sees them. The worker builds each
snapshot into one ustar archive in memory (`buildProfileTar`), after the hook switch has been applied
(section 7): every directory at mode 0755, every file at 0644 (0755 for an executable), all owned by
root, no link, device or other special entry, so nothing is group- or world-writable and nothing
carries setuid, setgid or the sticky bit. Every path is checked again when the archive is built (an
unsafe or duplicate path is refused, and so is one that does not fit ustar), the archive is written
to a private temporary directory (mode 0700) that is removed whether the copy succeeded or not, and
the workspace backend's `copyIn` hands it to the container (under Docker the daemon extracts it,
`docker cp - <container>:<dir>`; no binary in the container reads or writes the archive; under
Kubernetes the worker validates the archive first and the pod's own `tar` extracts it). File contents
are never logged.

**Written again before every turn, never checked in the container.** The agent can run as root in
its own container, so anything the container reports about its own files can be made to report the
honest answer: it can shim `find` and `sha256sum`, and a process it detached from the turn (`env -u
AUTO_SWE_EXEC_ID setsid ...`) escapes the turn's exec-tag kill and survives to rewrite plugin files
after a check. So the runtime does not verify the copy. Before EVERY turn it:

1. stops every process in the container except PID 1 and the keeper (`killStrays`, the same sweep
   the credentialed git calls use, whatever environment the process was started with);
2. runs one root script that never follows a link: a symlink (or any non-directory) at a profile
   directory or at `/workspace/.harness/profiles` is removed with `rm -f`, the profile directory is
   emptied and recreated as a real directory, and a link or non-directory in place of
   `/workspace/.harness` itself is removed and fails the turn (the binary and its home live there);
3. has the daemon extract each archive into its fresh directory;
4. asserts that the physical path of `/workspace/.harness`, the profiles directory and each profile
   directory (`cd -P` and `pwd -P`) equal the expected path, and otherwise fails the turn with a
   non-retryable `PROFILE_INTEGRITY`.

The harness is started only after this. The plugin paths it is given are always inside a profile
directory, so a link cannot send it to a checkout or any path outside `/workspace/.harness`. Stray
processes that an earlier turn left running are therefore stopped at the start of the next turn of a
profiled run. The rewrite does not grow per file, because each profile's archive is one transfer.

This is defence in depth, not a hard guarantee. It makes the cheap attacks fail (a replaced file,
an extra file, a loosened mode, a link into the checkout, a detached process that rewrites the
profile) and keeps plugin hooks, skills and scripts from changing between turns. It does not stop
code that runs during a turn from changing the files within that turn, and an agent running as root
in its own container can shim container tooling generally. Repository-supplied `.claude` hooks
already run in the container with the same authority, so tampering with a profile adds no capability
beyond them.

**Plugins.** Each plugin of each profile, in binding order, is passed to the SDK as
`plugins: [{ type: 'local', path: '<directory>/<plugin>', skipMcpDiscovery: true }]`. The SDK puts
them on the harness's command line (`--plugin-dir-no-mcp <path>`) and the custom spawn hands that
command line, unchanged, to the binary started in the container, so the paths are read there. A
plugin's commands, skills, sub-agents and auto-run sources (section 7) load; its MCP servers do not
(`skipMcpDiscovery`, and `strictMcpConfig` stays on). Everything else the worker sets is unchanged:
the policy settings layers, `managedSettings`, the worker-side hooks, the `canUseTool` deny,
`permissionMode`, the pinned API host and the tool allowlist rule.

**Instructions.** Each profile's `instructions` file is appended to the system prompt, after the
caller's prompt and skills, in binding order, each behind its own provenance line:

```
[profile: <name>@<version> sha <first 12 hex of contentHash>]
<instructions text>
```

The text is approved but still data: it is appended as written and never interpreted. A text that
itself spells a line starting `[profile:` is refused (non-retryable `PROFILE_INTEGRITY`) rather than
edited, so it cannot pass its own words off as the worker's line. The check is made on a normalized
copy: NFKC (full-width brackets and letters fold to ASCII), case-folded, invisible characters dropped,
CR, LF, CRLF, VT, FF, NEL, LS and PS all counted as line breaks, leading white space ignored, and
white space allowed inside the marker. The profile text counts toward the 100,000-character limit for
an inline prompt; a prompt past it is staged as a file in the container.

**Tools.** The profiles' `tools` add exactly those built-ins, as their union, to the SDK's `tools`
list and to the policy's allowlist, from one list so the two cannot disagree. Only `Skill` and
`Agent` can be added; `WebFetch`, `WebSearch` and anything else stay refused by the worker's policy
whoever asks, a plugin sub-agent definition that lists them included. A call to a tool outside the
allowlist is denied. `Skill` and `Agent` have no file or shell effect of their own and are allowed
when granted, within these limits:

- `Skill` runs only a skill or command one of the profiles' own plugins declares, in the
  plugin-qualified spelling `<plugin>:<name>` (`skills/<dir>/SKILL.md`, by directory name or
  front-matter `name`; `commands/<path>.md`, a subdirectory becoming `<dir>:<name>`; the plugin is
  its `plugin.json` name). The set is computed on the worker from the stored snapshots. A bare name is
  refused because a repository's own skill or command could answer to it; so are bundled skills, the
  repository's `.claude/commands/*.md` (whose `!` lines run shell commands when the command is
  invoked) and repository skills.
- `Agent` must state `run_in_background: false` (the SDK runs a sub-agent in the background unless
  told not to), and is refused when it sets `model` (the model proxy meters only the model it is asked
  for), `name` or `team_name` (they address or detach it), `isolation` (including a remote one), or a
  permission `mode` other than the default.

**Sub-agents.** The `PreToolUse` hook the worker registers also fires for a sub-agent's tool calls:
its input carries an `agent_id` (and `agent_type`) beside the tool name and input. Those calls go
through the same `decideToolCall` as the main agent's, with the same confinement to the checkout, the
same scanners and the same allowlist. The Docker suite starts a sub-agent from a mock model and shows
its denied command in the trace.

**The harness directory is not writable through policy.** A `Write` or `Edit` whose path (resolved
against the harness's current directory when relative, with `..` collapsed) falls under
`/workspace/.harness`, and a `Bash` command with a write target under it, are refused with the
sensitive-file tag. The write targets are the ones the shell scanner extracts (redirects, `tee`,
`dd of=`, the destination of `cp`/`mv`/`install`), with `~` expanded to the harness's home; a command
that names `.harness` at all and also uses a command that changes files or runs code (`rm`, `sed`, an
interpreter, any redirect) is refused too. Reads of the profile directories are allowed (plugins must
be readable); nothing else under `/workspace/.harness` is readable through the `Read`, `Glob` and
`Grep` tools.

**Recorded.** An `agent.profile` activity event, once per runtime and profile, carries the profile
name, version, the first 12 characters of the commit sha and content hash, the plugin directories and
the granted tools. An `agent.plugin_hooks` event carries the switch (section 7). Each `harness_turn`
transcript record carries `profile` (`name`, `version`, `contentHash`, `commitSha`), absent for an
agent with no profile.

**Other runtimes.** A profile is bound only to agents whose runtime is `claude-code`, but an agent can
still run on another loop: the run's runtime pin, an eval override, or a surface with no workspace
(`runAgentNode` without a workspace, which always runs on Mastra) puts it on Mastra or Pi. That is not
an error. The run proceeds without the profiles, an `agent.profile_not_applicable` event names the
agent, the profiles, the runtime it resolved to and the loop it ran on, and an `agent.plugin_partial`
event names what that loop skipped (commands, hooks and sub-agents). The plugins' skills reach such a
run as projected skills (section 13). The other `runAgent` callers (channel turns, memory passes,
workflow authoring) always run on Mastra and do not report it.

## 10. Update tracking

Each profile follows the ref its source names: a branch or tag as the admin gave it, `HEAD` for a
profile a bundle created (section 14), and for a marketplace entry the ref the entry or its
marketplace names (section 11).

**The check.** Resolving a profile's ref costs one request. The check records `latestSha` (the commit
the ref names when the check runs), `lastCheckedAt`, `lastError` and `trackStatus`:

- `OK` when `latestSha` is the commit of the profile's latest version;
- `UPDATE_AVAILABLE` when it is a different commit;
- `ERROR`, with a fixed message from the skill-source errors, when the host could not answer.

A rate-limit answer only moves `lastCheckedAt`. A check never changes a version, a binding or the hook
switch, and it does nothing to a profile that is disabled.

**The sweep.** The check runs for every profile that is not disabled as part of the skill-source
sync: the `syncSkillSources` activity runs the skill-source sweep and then the profile sweep, one
request at a time. A failing profile never stops the others or the skill-source sweep. The schedule is
the skill-source one (`SKILL_SOURCE_SYNC_ENABLED`, `SKILL_SOURCE_SYNC_CRON`), so switching that sync
off also stops profile checks (see [configuration.md](./configuration.md)).

**Acting on it.** `POST /harness-profiles/:name/check` runs the same check for one profile on request; a
disabled profile answers `409 HARNESS_PROFILE_DISABLED`. The admin then reads the ref again with
`POST /harness-profiles/:name/preview-update`, which reports `matchesVersion` when the content already
is a version and `hookChanges` (section 7), and accepts with `POST /harness-profiles/:name/accept`.
Accepting the commit the last check found clears `lastError` and sets `trackStatus` to `OK`.

**Marketplace-bound profiles** are re-read as the plugin folder they were approved from, wrapped in
the same synthesized `profile.json` the approval used, so preview-update and accept read them exactly
as approval did. Their update flag can come from a change elsewhere in the marketplace repository
(Limitations).

## 11. Marketplaces

A marketplace is a repository folder holding `.claude-plugin/marketplace.json`. It is tracked as a
`MarketplaceSource` pinned to the commit its catalog was read at. The catalog is read again at each
view; nothing installs from it except an explicit entry approval.

**Catalog format.** Strict about the fields it reads: `name`, `owner`, `plugins[]` with `name`,
`description`, `version` and `source`, and `metadata.pluginRoot`. Every other key is listed as
`ignoredKeys` and is never an error (`strict` is one of them). One bad entry does not fail the file: it
is listed as not installable with a fixed reason. A file over 1 MB, one with more than 500 entries, or
one that is not valid UTF-8 JSON is refused with `MARKETPLACE_INVALID`.

**Entry sources.**

| Source | Installable |
|---|---|
| A relative path, such as `./plugins/tools`, read at the pinned commit inside the marketplace repository (`metadata.pluginRoot` is joined in front of it). | Yes |
| `{ "source": "github", "repo": "owner/name", "path"?, "ref"?, "sha"? }` on `github.com`. Without `sha` the ref is resolved at approval and the approval binds to that commit. | Yes |
| A string that names a URL or scheme, a `{ "source": ... }` of another kind (git URL, npm, another host), or a path that is not a safe relative folder. | No, listed with a reason |

An entry whose name appears twice is not installable by either entry. A name that is not a valid
profile name, or an entry that is not an object, is not installable.

**Adding and tracking.**

- `POST /marketplaces/preview` reads the catalog at the ref and returns it with the commit, and
  `existingId` when the marketplace is already tracked. `POST /marketplaces` adds the source pinned to
  the previewed commit (`MARKETPLACE_EXISTS` for a tracked one, `MARKETPLACE_SHA_MOVED` when the ref
  moved).
- The marketplace sweep (`syncMarketplaces`, `MARKETPLACE_SYNC_ENABLED`, `MARKETPLACE_SYNC_CRON`)
  asks each non-disabled marketplace's host which commit its ref names. It records `latestSha` and
  `status`: `UPDATE_AVAILABLE`, `OK` or `ERROR`. It never moves a pin, approves an entry or changes a
  profile. `POST /marketplaces/:id/check` does the same for one source.
- `POST /marketplaces/:id/accept-update` moves the pin to a commit the ref still names, after the
  catalog reads at that commit. The pin moves only if it still holds the commit the check was made
  against, and the source is read back through the same transaction. It installs nothing and changes
  no profile. The same commit answers `MARKETPLACE_NO_CHANGE`.
- `PATCH /marketplaces/:id` sets `status` to `DISABLED` or back to `OK`. A disabled source answers
  `MARKETPLACE_DISABLED` to a check, an accept, and an entry read or approval.
- `DELETE /marketplaces/:id` removes the source. Profiles approved from it keep working; their
  `marketplaceSourceId` is cleared.

**Approving an entry.**

1. `POST /marketplaces/:id/entries/preview` with `{ entry, sha? }` reads the entry at the pinned
   commit (a relative entry) or at its own commit (a GitHub entry; `sha` is needed for one that names
   only a ref) and returns the wrapped profile's preview: manifest, files, warnings, `contentHash`,
   `warningsHash`, the MCP servers it declares, `hasHooks` (whether any auto-run source of section 7
   exists) and any `conflicts` by name.
2. `POST /marketplaces/:id/entries/approve` with `{ entry, sha, contentHash, warningsHash,
   hooksEnabled, acknowledgeWarnings? }` re-reads the entry, requires the same content and warnings
   (`PREVIEW_STALE` otherwise), requires acknowledgement of any warnings, and creates a single-plugin
   profile at version 1, named after the entry, with `marketplaceSourceId` and `marketplaceEntry`
   set. A name already taken answers `HARNESS_PROFILE_NAME_EXISTS`.
3. Approval does not project the plugin's skills (Limitations).

The catalog marks each entry with the profile approved from it (`profile`) and with `nameTaken` when
another profile holds its name.

**MCP servers.** The harness never loads a plugin's `.mcp.json`. The entry preview lists the servers
the file declares, by name, transport and URL (origin and path only; no credentials, query or
fragment; never commands, arguments, headers or environment values):

- an HTTP server is a **declared dependency**. The warning asks an administrator to point the agent's
  existing `mcpConnectionId` at a matching `mcp` Connection. The platform does not check the match,
  and there is no mapping table and no run-time effect;
- a stdio or sse server is flagged as not supported and is not available.

Because an HTTP server always adds a warning, approving a plugin that declares one needs
`acknowledgeWarnings: true`.

## 12. Team enablement

A platform ADMIN approves a plugin for the platform. A team admin then enables it for their team, and
only an enabled plugin can be bound on a TEAM-scoped agent of that team.

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/v1/teams/:teamId/plugins` | Any team member | Approved plugins with `enabled`, `enabledAt`, `hooksEnabled`, `latestVersion` and `status`. A DISABLED plugin is listed only when this team holds an enablement for it, so the team admin can withdraw it. |
| `PUT /api/v1/teams/:teamId/plugins/:name` | Team ADMIN (a platform ADMIN passes) | Enable one plugin for the team. Idempotent. `TEAM_INACTIVE` for an inactive team; `HARNESS_PROFILE_DISABLED` for a disabled profile. |
| `DELETE /api/v1/teams/:teamId/plugins/:name` | Team ADMIN | Disable one plugin for the team. `NOT_FOUND` when it was not enabled. The response lists `strandedAgents`. |

**What enablement governs.** Enablement applies to a binding on a TEAM-scoped agent version, the
version a team admin writes. A platform-wide (GLOBAL), organization, channel or workflow-template
binding is written by a platform ADMIN and needs no enablement, at save or at run time.

- A TEAM-scoped binding needs its team's enablement at save (`PROFILE_NOT_ENABLED`) and at every
  resolution of that binding (`PLUGIN_NOT_ENABLED`), not only at the run's first use. The pin decides
  the version; it does not decide the permission.
- A binding the run has verified is the exception. The run's pin lists that binding, keyed by team,
  agent key and agent version, under `verified` when it passed the check at run start or at its first
  use. Removing the
  enablement during the run does not stop that binding for that run, its retries included. A binding
  first seen after the removal fails closed.
- Removing an enablement changes no agent. `DELETE` answers with `strandedAgents`: the team's
  TEAM-scoped versions that name the plugin. The plugin's detail page lists every bound agent,
  with `stranded` set when the profile is not OK, or when the agent is TEAM-scoped and its team has no
  enablement.
- A disabled profile cannot be enabled by a team (`HARNESS_PROFILE_DISABLED`). Disabling a profile
  does not remove enablement rows already recorded.

## 13. Skill projection for other runtimes

Only `claude-code` loads a plugin's commands, hooks and sub-agents. So that the skills of a plugin
are usable elsewhere, each `skills/<dir>/SKILL.md` of each plugin is projected into a `Skill` row
(`packages/shared/src/lib/harnessProfile/projection.ts`).

- **Rows.** Named `<plugin>:<skill>`, where the plugin is its `plugin.json` name (else its directory)
  and the skill is the front-matter `name` (else the directory). `GLOBAL` scope, `isBuiltIn` false,
  `isVerified` false (plugin text is third-party until a person verifies it), with `pluginProfileId`
  and `pluginVersion` set, and a `sourcePath` of `plugin:<profile>/<folder>`. `.md` and `.txt` files
  beside a `SKILL.md` are kept as reference files.
- **When.** After a profile version commits: folder approval, an accepted update, and a bundle install
  (section 14). A marketplace entry approval does not project (Limitations). A projection failure never
  undoes the approval; the response carries a `projection` object with `created`, `updated`, `refused`
  and `failed`.
- **Never older.** A projection never moves a skill back to an older version of its profile. A row
  whose `pluginVersion` is newer than the version being projected is refused.
- **Scanning.** The scanner runs over each skill's description and text. With
  `skills.import.blockOnScanWarnings` on (the default), a skill with any warning (an incomplete scan
  included) is refused and nothing is written for it. Refused skills are returned with their reason.
- **Hand edits are refused, never overwritten.** A projected row whose text differs from its newest
  projection revision was edited by hand, and is refused. A row of the same name from another plugin,
  or one that is not a projection, is refused too.
- **Revisions.** A change to a skill's text or description cuts a further `SkillRevision`; an unchanged one
  does not. Runs keep the revisions they pinned.
- **Disable and enable.** Disabling a plugin deactivates its projected skills in the same transaction.
  Each row the disable switches off is stamped with `Skill.pluginDeactivatedAt`. Re-enabling
  reactivates exactly the stamped rows, whatever version they were projected from. A row the disable
  did not touch keeps its state. Projection reads the profile's status under a row share lock, so a
  row written while the plugin is disabled is born inactive and stamped, and a disable that lands
  during a projection waits for it and then deactivates the row.
- **Writes refused.** An update, a rename, a verify, a delete, a revision restore, or a bundle install
  that would replace a projected skill answers `409 SKILL_PLUGIN_MANAGED`. Its text, name and state
  change only by accepting a plugin version (or disabling the plugin).
- **Attaching.** An agent version cannot add a skill of a disabled plugin (`SKILL_PLUGIN_DISABLED`, any
  scope). A TEAM-scoped version cannot add one whose plugin the team has not enabled
  (`SKILL_PLUGIN_NOT_ENABLED`). Skills the version already carries are not re-checked, and removal is
  always allowed. A bundle that references a skill of a disabled plugin is refused (section 14).
- **At run time.** A projected skill whose plugin is disabled, or, on a TEAM-scoped version, not enabled
  for the run's team, is dropped from the prompt with an `agent.plugin_skill_excluded` event. This is
  not a failure.
- **Reaching a run.** A projected skill is a library skill; an agent uses it through its skill
  references, like any other skill, on a runtime other than `claude-code`. On `claude-code` the plugin
  loads its own skills from the plugin directory.
- **Read-only in the dashboard.** The dashboard marks a projected skill read-only and says it changes
  when a version is accepted. `GET /api/v1/platform/skills` reports `plugin: { profileId, name, version }`
  for it, or `null` for any other skill.

## 14. Bundles

A bundle carries a plugin **by reference** (`entities.plugins`, bundle schema v3): the profile name,
its source coordinates, the exact commit, the profile's content hash and the agent keys it is bound to.
The plugin's files never travel, and neither do the switch, the enablements or the tracking state.
Export writes one reference for each profile a platform-wide agent in the bundle is bound to, at the
newest approved commit. [bundles.md](./bundles.md) has the manifest, the trust model and the preview.

On install the gateway, for each plugin reference, reads the folder at the pinned commit through the
guarded fetcher and requires the computed content hash to equal the bundle's:

- a different hash answers `400 BUNDLE_PLUGIN_HASH_MISMATCH`; a folder that is not a valid profile, or
  names another profile, answers `400 BUNDLE_PLUGIN_INVALID`; a refused or failed read answers
  `400 BUNDLE_PLUGIN_FETCH_FAILED`. Nothing is written in any of these cases.
- A profile created by the install has `hooksEnabled: false`, its first version approved by the
  installing admin, and `ref: HEAD`, so its update check follows the default branch. Only a platform
  ADMIN switches hooks on, separately, against the latest version the admin reviewed (section 7).
- A profile of that name with the same content hash is reused and its switch is not touched. A name
  approved with different content answers `409 PROTECTED_CONTENT_OVERWRITE`, and `overwriteProtected`
  does not lift it.
- The approval warnings of every profile the install would create come back in `warnings`, and the
  install answers `409 WARNINGS_UNACKNOWLEDGED` until the request carries `acknowledgeWarnings: true`.
- Each binding cuts a further version of the named GLOBAL agent with the plugin name appended to its
  `harnessProfiles`. It applies only when the agent runs on `claude-code`. An agent that is missing,
  on another runtime, or already bound is reported in `warnings` or skipped. A binding that would
  leave an agent with two plugins of one name, or the same profile twice, is refused
  (`PROFILE_NAME_COLLISION`, `PROFILE_DUPLICATE`) and rolls back the whole install.
- A reused profile is bound at its latest version. When the bundle's referenced version is not the
  latest, the install warns with both numbers and projects no skills for it. The install result lists
  `boundVersion` for each plugin (`plugins.bound`).
- After commit the installed plugins' skills are projected (section 13). A projected skill that the
  bundle names as a plain GLOBAL skill answers `409 SKILL_PLUGIN_MANAGED`; an agent that references a
  skill of a disabled plugin answers `400 SKILL_PLUGIN_DISABLED`. Either way nothing is installed.

## 15. API

All routes are under `/api/v1/platform` and require the ADMIN role. None is available to the in-app
assistant for writes; list and get are readable.

**Harness profiles** (`/api/v1/platform/harness-profiles`):

| Method and path | Purpose |
|---|---|
| `POST /preview` | Body `{ host?, owner, repo, path?, ref }`. Reads, validates and scans; writes nothing. Returns the manifest, files (path, size, mode), warnings, `sha`, `contentHash`, `warningsHash`, and name conflicts. With `{ file, sha }`, returns that one file's text for review (`binary: true` and `text: null` for non-text, cut at 200,000 characters with `truncated: true`). |
| `POST /` | Body `{ ..., sha, contentHash, warningsHash, hooksEnabled, acknowledgeWarnings? }`. Creates the profile and version 1 at the previewed commit and returns the skill `projection`. `409 SHA_MOVED`, `409 PREVIEW_STALE`, `409 WARNINGS_UNACKNOWLEDGED`, `409 HARNESS_PROFILE_NAME_EXISTS`, `422 HARNESS_PROFILE_INVALID`. |
| `GET /` | Profiles with their latest version and tracking state (no file lists, no content). |
| `GET /:name` | One profile with every version and its file list, `boundAgents` (each with `stranded`), `enabledTeams` and `autoRunSources`: every auto-run source (section 7) of the latest version, with its `path`, `kind`, `commands` and `unreadable` reason. |
| `POST /:name/preview-update` | Body `{ sha?, file? }`. Reads the profile's stored source again (or the named commit) and reports `matchesVersion`, `hookChanges` and `hooksEnabled`. The manifest name must equal `:name`. |
| `POST /:name/accept` | Body `{ sha, contentHash, warningsHash, acknowledgeWarnings?, acknowledgeHookChanges? }`. Adds the next version and returns the skill `projection`. `409 PREVIEW_STALE`, `409 HARNESS_PROFILE_NO_CHANGE`, `409 HARNESS_PROFILE_DISABLED`, `409 HOOK_CHANGES_UNACKNOWLEDGED` (with `hookChanges`), `409 HARNESS_PROFILE_CHANGED` when another accept or a switch change won the race. |
| `PATCH /:name` | Body `{ status?: 'OK' \| 'DISABLED', hooksEnabled?: boolean, expectedVersion?: number }`; at least one. The hook switch is set here and cuts no version. `hooksEnabled: true` needs `expectedVersion`, the latest version the admin reviewed: `400 HOOKS_EXPECTED_VERSION_REQUIRED` without it, `409 HOOKS_VERSION_STALE` (with `details.latestVersion`) when the profile has moved on (section 7). Disabling a profile also deactivates its projected skills (section 13). |
| `POST /:name/check` | Resolves the ref on request and records the result (the sweep's check). `409 HARNESS_PROFILE_DISABLED`. Returns `recorded: false` when the profile changed under the check. |
| `GET /:name/enablements` | The teams that enabled the profile. |

There is no `DELETE`: an agent may reference a profile by name, so a profile is disabled, not removed.

**Marketplaces** (`/api/v1/platform/marketplaces`):

| Method and path | Purpose |
|---|---|
| `POST /preview` | Body `{ host?, owner, repo, path?, ref }` (`sha?` to read a named commit). Reads the catalog; writes nothing. |
| `POST /` | Body `{ ..., sha }`. Adds the source pinned to the previewed commit. `409 MARKETPLACE_EXISTS`, `409 MARKETPLACE_SHA_MOVED`. |
| `GET /` | Sources with their status and profile count. |
| `GET /:id` | One source with its catalog at the pinned commit (`catalog`, or `catalogError`). |
| `PATCH /:id` | Body `{ status: 'DISABLED' \| 'OK' }`. |
| `DELETE /:id` | Removes the source; approved profiles keep working. |
| `POST /:id/check` | Asks the host for the ref's commit on request and records the result. |
| `POST /:id/accept-update` | Body `{ sha }`. Moves the pin; installs nothing and changes no profile. `409 MARKETPLACE_NO_CHANGE`, `409 MARKETPLACE_CHANGED`. |
| `POST /:id/entries/preview` | Body `{ entry, sha? }`. The profile preview of one entry; writes nothing. |
| `POST /:id/entries/approve` | Body `{ entry, sha, contentHash, warningsHash, hooksEnabled, acknowledgeWarnings? }`. Creates the single-plugin profile. |

**Team enablement** (`/api/v1/teams/:teamId/plugins`): the three routes in section 12.

**Skills** (`/api/v1/platform/skills`): a skill projected from a plugin carries `plugin`
(`{ profileId, name, version }`), and writes to it answer `409 SKILL_PLUGIN_MANAGED` (section 13).

Fetch refusals use the fixed `HARNESS_PROFILE_<CODE>` and `MARKETPLACE_<CODE>` codes, with the same
strings as skill sources.

## 16. Dashboard

The Plugins page at `/admin/harness-profiles` (platform ADMIN, under Security) has two tabs, the
second at `?tab=marketplaces`.

- **Plugins.** Lists every profile with its latest version, commit, file count, warning count, status,
  tracking state and whether it came from a marketplace. **Add plugin** previews a folder (host,
  owner, repository, path, ref, or a pasted GitHub link), then shows the manifest, the commit, the
  validation result, the warnings and every file, which can be opened at that commit. Approval asks
  for the hook choice (on or off) and is disabled while the name collides and, when the preview has
  warnings, until they are acknowledged. Choosing hooks on needs a "reviewed" box before approval; the
  hook files are read in the preview's file list. The marketplace entry approval has the same choice
  and box. **Details** shows the source, every version with its files and the warnings acknowledged at
  approval, the hook switch (turning it on lists the latest version's hook sources, with the same
  "reviewed" box, and sends that version), the teams that enabled the plugin and
  the agents bound to it (stranded ones marked), **Check for update** (preview-update, with the hook
  diff), and disable or re-enable.
- **Marketplaces.** Add a marketplace (preview, then add at the previewed commit), see its catalog at
  the pinned commit with each entry's status and the profile approved from it, preview and approve an
  entry, check for an update, review and accept a moved pin, disable, or remove.

On a team's settings page, the **Plugins** section lists the approved plugins for that team, with
enablement for a team admin.

All repository-derived text (names, descriptions, paths, warnings, file content) is shown with control
and invisible characters made visible, as plain text. Stored version content is not readable on the
page: a file's text is read from a preview of a commit, and a stored version shows its file list and
warnings only.

---

## Limitations

- **The hook switch covers the auto-run sources section 7 lists, and no others.** A kind of auto-run
  source that the harness starts from a plugin, but that `hookSources.ts` does not name, is not left
  out when the switch is off, is not in the hook diff and is not scanned. Such a source is covered only
  once that module is extended.
- **Scripts and executables are written when hooks are off.** The switch removes declared commands
  only. The agent can run a script the plugin ships, and the dashboard says so beside the switch.
- **Turning hooks on does not reach a run in flight.** A run takes its hook switch from its pin, so a
  switch turned on takes effect only for runs that start afterwards. Turning it off reaches the next
  activity of a run in flight.
- **Plugin MCP servers are never loaded.** The harness loads no MCP server from a plugin, and stdio and
  sse servers are unsupported. An HTTP server is a declared dependency: the match to an `mcp`
  Connection is a manual admin step that the platform does not check, and the agent's own connection
  is what runs.
- **Commands, hooks, sub-agents and the other auto-run sources apply only on `claude-code`.** Other
  runtimes get the plugin's skills as projected rows. The `agent.plugin_partial` event names commands,
  hooks and sub-agents; monitors and LSP servers are skipped on those runtimes too, but the event does
  not name them.
- **A binding verified by a run keeps working for that run after its team's enablement is removed.**
  The exemption covers the run's retries too, and only for that team, agent key and agent version. A
  binding first seen after the removal fails closed.
- **The frontmatter scan reads only the markdown files it locates.** It reads a `hooks` key from
  `skills/**/SKILL.md`, `commands/**/*.md`, a root `SKILL.md` and the `.md` files a `skills` or
  `commands` ref names. A `.md` file outside those places is not read, so a `hooks` key in it is not a
  source, the hook switch does not remove it, and it is not scanned. Whether the harness loads such a
  file as a skill or command is not checked by the module.
- **Approving a marketplace entry does not project its skills.** Folder approval, an accepted update and
  a bundle install do.
- **Projected skills are not removed upstream.** A skill that disappears from the plugin stays installed
  and is not reported. A hand edit is refused and never overwritten.
- **A bundle that reuses an older version binds the latest.** The profile of the bundle's name, with
  the bundle's content hash, is reused, but its agents run the latest approved version. The install
  warns with both numbers, and the older version's skills are not projected.
- **Bundle-created profiles track `HEAD`.** A bundle pins a commit, but the profile follows the default
  branch, so a bundle gives no way to follow a tag or branch. Its update checks compare against the
  commit the bundle named.
- **A GitHub entry is read from `github.com` only.** A marketplace itself may sit on any approved host,
  but a GitHub Enterprise repository named by an entry is not accepted as an entry source.
- **A marketplace-bound profile follows a moving commit.** A relative entry's profile tracks the
  marketplace repository's ref, so an update is flagged whenever anything in that repository moves, and
  a GitHub entry's profile follows the ref it names rather than the commit it was approved at.
  `preview-update` reports `matchesVersion` when the plugin's own content is unchanged.
- **Large repositories are refused.** A tree listing that GitHub truncates refuses the read, for a
  marketplace catalog and for a plugin folder alike.
- **The profile check shares the skill-source schedule.** Switching `SKILL_SOURCE_SYNC_ENABLED` off stops
  the profile checks as well as the skill-source checks.
- **The column replacement has no old-column fallback.** The migration converts `agents.harness_profile`
  in place into `agents.harness_profiles` and drops the old column. Code that still reads the old column
  fails on it, so the gateway and the worker must be upgraded together
  ([upgrade-notes.md](./upgrade-notes.md)).
- **Approval is platform-wide and admin-only.** There is no team or organization scope for approving a
  plugin and no delegation of approval; teams enable and bind what an administrator approved.
- **No inheritance of the binding.** Personas that inherit a model do not inherit the plugins; each agent
  version is bound explicitly.
- **Stored file content is not reviewable on the page.** File text is read from a preview of a commit
  (add, check for update); a stored version shows its file list and warnings only.
- **A commit sha does not prove branch membership.** A raw sha can name a commit that exists only in a
  fork of the repository, because GitHub serves fork commits through the parent. The recorded
  `owner/repo@sha` says where the content was read, not that the commit is on the repository's branches.
- **Names are not reusable.** A profile cannot be deleted or renamed, so its name stays taken. Uniqueness
  ignores case and is enforced by a database index on `lower(name)`.
- **Hooks and scripts run in the container with the agent's authority.** The scanners at approval are
  advisory, and the worker's policy decides tool calls, not what a hook or script does once it runs. The
  user the harness runs as can do whatever that user can in its container.
- **Protection of the profile directories is a tripwire plus a rewrite, not a boundary.** The policy
  refuses writes under `/workspace/.harness` by path and by command text, which a determined agent with
  arbitrary `Bash` can evade (an interpreter, an encoded path, a variable) and which does not stop a
  plugin script that runs on its own. Behind it the profiles are stopped-and-rewritten from the worker's
  snapshots before every turn (section 9), so a change made between turns does not survive to the next
  turn. A change made during a turn, by a hook or by a process the agent starts, takes effect within that
  turn. An agent running as root can also replace tools and files other than the profiles. The
  directories are created by `mkdir` inside the container and are owned by root, so a root-owned agent can
  unlink and replace the files in them; file ownership does not protect them on either backend.
- **A plugin hook can change a call after the worker allowed it.** The binary applies a plugin
  `PreToolUse` hook's `updatedInput` after the worker's `PreToolUse` hook has allowed the call, so the
  tool runs the input the plugin produced while the worker decided the original (the Docker suite shows a
  plugin rewriting a `Bash` command and the rewritten command running). Only an approved plugin can do
  this, never the agent or the repository, and the hook already runs in the container with the agent's
  authority. Possible mitigations, none built: refuse a `PreToolUse` hook that returns `updatedInput` at
  approval (it is visible in the preview), compare the executed input in the `PostToolUse` hook with the
  decided one and record or fail on a difference, or order the worker's hook after the plugins'.
- **Disabling a profile is not a kill switch for runs that pinned it.** A pinned version keeps resolving
  after the profile is disabled, and the run-start upsert in `activities/templates.ts` keeps the pins of a
  run across re-executions of the same workflow. A disabled profile stops runs that start after it from
  resolving it and from being bound to it; it does not stop a run that already pinned it, nor a retry of
  that run. To pull a profile from running work, cancel those runs, or bind the agents to a different
  profile, and approve a further version.
- **`Skill` and `Agent` widen what the model can attempt.** They add no file or shell capability, but a
  sub-agent is another conversation with its own prompt, and a skill is more text in the conversation.
  Every tool call either makes is still decided by the worker's policy, but the policy sees a call, not
  the conversation that led to it.
- **Sub-agent coverage depends on the harness firing the hook.** The worker relies on the harness calling
  `PreToolUse` for a sub-agent's tool calls. It does so in the SDK's default mode, as the Docker suite
  shows; the SDK documents the `agent_id` field for it. A mode of the harness that ran sub-agent tools
  without the hook would bypass the policy for them, and the `canUseTool` deny and the policy settings
  layers would be the only remaining control.
- **Not applied on other runtimes.** Mastra, Pi and any surface with no workspace run the agent without its
  plugins (`agent.profile_not_applicable`); nothing emulates plugins or instructions there.
- **Every turn costs a sweep, a script and one transfer per profile.** Each profile directory is written
  again each time, whatever it held, and stray processes from an earlier turn are stopped at the start of
  the next one, so a server an agent left running in a profiled run does not outlive the turn that started
  it.
