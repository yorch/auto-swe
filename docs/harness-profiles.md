# Harness profiles

> A harness profile is an administrator-approved bundle of Claude Code plugins (commands, skills,
> sub-agents, hooks, scripts) and instructions, read from a folder of a GitHub or GitHub Enterprise
> repository at an exact commit and stored as an immutable, content-hashed snapshot. This page covers
> the data model, the fetcher, the validation and scanning that run at approval, the admin API, how
> a profile is bound to an agent, and what the Claude Code runtime does with it in a run container.

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
`.` or `..` segment, a segment over 255 bytes or a path over 1024 bytes (UTF-8), a backslash, a control or invisible character, a `.git` segment, or two paths
that collide after Unicode normalisation and case folding. A profile that silently lacked a file
would not be the profile the administrator reviewed.

**Every file is stored**, whatever its type: scripts and binaries too. Plugin `.mcp.json` files are
stored but ignored at run time (the harness runs with a strict MCP configuration), and the preview
says so.

## 2. Snapshot identity

`contentHash` is the sha256 over the canonical, sorted list of `(path, mode, sha256(content))` plus
the parsed manifest. It does not depend on the order files arrive in or on the key order of the
manifest. A version row is immutable: a change is a new version.

## 3. Data model

| Model | Table | Purpose |
|---|---|---|
| `HarnessProfile` | `harness_profiles` | One profile: unique `name`, description, source (`host`, `owner`, `repo`, `path`, `ref`), `status` (`OK` or `DISABLED`), `latestVersion`. Global; never deleted. |
| `HarnessProfileVersion` | `harness_profile_versions` | One immutable snapshot: `version` (unique per profile), `commitSha`, `contentHash`, `manifest`, `fileIndex` (path, size, mode), `files` (a gzipped blob of every file), `scanWarnings`, `approvedById`. |

The blob is packed and unpacked by `packFiles` / `unpackFiles`
(`packages/shared/src/lib/harnessProfile/snapshot.ts`). The decompressed bound is derived from the
file and path limits, so any snapshot that packs at approval unpacks. Unpacking re-checks every
path, the file count, per-file and total sizes and case-insensitive collisions.
`unpackAndVerify(blob, manifest, contentHash)` additionally recomputes the content hash and throws
on a mismatch; anything that materialises a snapshot uses it, so a blob altered after approval
(a changed file, an extra file, a flipped mode) is refused.

## 4. Reading a folder

The gateway reads a folder once, at approval. `readProfileFolder` reuses the skill-source fetcher
(see [agents.md §6.6](./agents.md#66-external-skill-sources)): the repository host policy
(`github.com`, the instance's host, or a host in `github.repositoryHosts`), the SSRF guard and
connection pinning, manual redirects with the credential sent only to the API origin, the
platform credential only (never a user's), the shared rate floor, and fixed error strings that
never echo upstream text. It then:

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

- plugin MCP servers are stored but ignored at run time;
- hooks are present (they run commands inside the run container);
- scripts are present;
- files have the executable bit set;
- files outside the instructions and plugins are stored but never used.

Scanning (`scanProfile`) is advisory and executes nothing. The platform's skill-content scanner runs
over the instructions and every plugin `.md`; the shell-command patterns run over every hook command
in `hooks/hooks.json`, in a plugin's inline `hooks`, and in any hooks file a plugin's `plugin.json`
names by path (a string, or an array mixing paths and inline objects) inside the plugin folder, and
over every script, executable file and file that starts with `#!`. A `hooks` path that leaves the
plugin folder, does not exist or is not valid JSON adds a `hooks-not-scanned` warning: the hooks it
names would still run.
A scan that could not run every rule over everything adds a `scan-incomplete` warning rather than
reading as clean. Binary content and invalid UTF-8 prose are reported as not scanned.

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

- ADMIN only, GLOBAL scope. A profile's hooks and scripts run commands in the run container, so who
  may bring one in is a platform decision.
- Nothing is executed at preview or approval, and the worker never fetches a repository.
- The reviewed bytes are the stored bytes: a version is created from the commit the preview showed
  and the request fails with `SHA_MOVED` if the ref moved.
- The API never returns file content from list or get. The one exception is the explicit
  single-file review request below.
- Profiles are not deleted, because an agent may reference one by name. A disabled profile takes no
  new version and must not be newly bound or newly pinned.
- Every create, accept and status change is written to the audit log under the entity type
  `HarnessProfile`.

## 7. API

All routes are under `/api/v1/platform/harness-profiles` and require the ADMIN role. None is
available to the in-app assistant for writes; list and get are readable.

| Method and path | Purpose |
|---|---|
| `POST /preview` | Body `{ host?, owner, repo, path?, ref }`. Reads, validates and scans; writes nothing. Returns the manifest, files (path, size, mode), warnings, `sha`, `contentHash`, `warningsHash`, and name conflicts. With `{ file, sha }`, returns that one file's text for review (`binary: true` and `text: null` for non-text, cut at 200,000 characters with `truncated: true`). |
| `POST /` | Body `{ ..., sha, contentHash, warningsHash, acknowledgeWarnings? }`. Creates the profile and version 1 at the previewed commit. `409 SHA_MOVED`, `409 PREVIEW_STALE`, `409 WARNINGS_UNACKNOWLEDGED`, `409 HARNESS_PROFILE_NAME_EXISTS`, `422 HARNESS_PROFILE_INVALID`. |
| `GET /` | Profiles with their latest version (no file lists, no content). |
| `GET /:name` | One profile with every version and its file list. |
| `POST /:name/preview-update` | Body `{ sha?, file? }`. Reads the profile's stored source again (or the named commit) and reports `matchesVersion` when the content equals an existing version. The manifest name must equal `:name`. |
| `POST /:name/accept` | Body `{ sha, contentHash, warningsHash, acknowledgeWarnings? }`. Adds the next version. `409 PREVIEW_STALE` when the content or warnings differ from the preview. `409 HARNESS_PROFILE_NO_CHANGE` for content that already is a version, `409 HARNESS_PROFILE_DISABLED`, `409 HARNESS_PROFILE_CHANGED` when another accept won the version number. |
| `PATCH /:name` | Body `{ status: 'OK' \| 'DISABLED' }`. |

There is no `DELETE`. Fetch refusals use the fixed `HARNESS_PROFILE_<CODE>` codes with the same
strings as skill sources.

### Dashboard

`/admin/harness-profiles` (ADMIN) lists every profile with its latest version, commit, file count,
warning count and status, and drives the same API:

- **Add profile** previews a folder (host, owner, repository, path, ref, or a pasted GitHub link),
  then shows the manifest, the exact commit sha, the validation result, the warnings and every file.
  Each file can be opened (the `file` preview option, at the previewed commit). Approval sends the
  previewed `sha`, `contentHash` and `warningsHash`; it is disabled while the name collides with an
  existing profile and, when the preview has warnings, until they are acknowledged. A `409
  PREVIEW_STALE` or `SHA_MOVED` answer offers a fresh preview.
- **Details** shows the source, every version with its file list and the warnings acknowledged at
  approval, and **Check for update** (`preview-update`), which reads the stored source again, says
  when the content already is a version, and accepts a changed one as the next version under the
  same rules.
- **Disable** (after a confirmation) and **Enable** use `PATCH`.

All repository-derived text (names, descriptions, paths, warnings, file content) is shown with
control and invisible characters made visible, as plain text. Content of a stored version is not
readable on the page, because the API returns it only for a preview.

## 8. Binding a profile to an agent

`Agent.harnessProfile` (nullable text) holds the **name** of an approved profile. It is a plain
name, not a foreign key: profiles are never deleted and names never change, and a name that stops
resolving fails the run closed (below) rather than degrading.

- **Set on the version itself.** It is not inherited along `inheritsModelFrom`: a fixer or
  persona never silently picks up the implementer's instructions and plugins. Bind each agent
  that should have a profile.
- **Platform ADMIN only.** Setting or changing it answers `403 PROFILE_ADMIN_ONLY` to anyone else.
  A team admin editing other fields of a TEAM override keeps the value an ADMIN chose and may
  restate it, but not change it. A new scoped override starts with the platform-wide row's
  profile, as it does with the runtime. An ADMIN clears it with `null`. Omitting the field on a
  save keeps it.
- **Claude Code runtime only.** The version's effective runtime (its own, else the one inherited
  along the platform-wide chain) must be `claude-code`, otherwise `400 PROFILE_RUNTIME_MISMATCH`;
  the same rule refuses moving a bound version off `claude-code`. The bulk model remap's
  `adaptRuntime` clears the profile together with the runtime.
- **Must be usable when bound.** `400 PROFILE_NOT_FOUND` for an unknown name and
  `400 PROFILE_DISABLED` for a disabled profile. A profile disabled later does not block editing
  the agent's other fields.
- **Restoring a version** restores its profile with its runtime and applies the same checks.
- The agent library DTOs and listing carry `harnessProfile`. The dashboard's agent form (create and
  edit, platform-wide library) offers a platform ADMIN a picker of the enabled profiles (a bound
  profile that was disabled later stays listed, marked), and sends `harnessProfile` only when the
  value changed. Everyone else, and the per-team override form, sees the bound name read-only.

**Resolution.** `resolveHarnessProfile(agentKey, ctx, resolved?)` reads the profile name from the
agent's resolved version (the caller's own resolution when it passes one, so the profile always
comes from the same Agent version as the model and tools of that run), then picks the profile version: the run's pin, else the profile's latest version
(which must be OK). It returns the name, version, commit, content hash, manifest and files, and
verifies the stored snapshot against its content hash before handing the files out.

**Run pin.** `WorkflowRun.harnessProfileVersions` is `{ profileName: version }`. At run start the
worker pins the latest version of every OK profile bound to an agent the run can resolve (same
scope and agent-version pins as the runtime snapshot; channel turns too). An agent with no entry
pins the version it first resolves with a compare-and-set on the whole map, so two activities
pinning different profiles keep both entries and an existing pin is never overwritten. A run that
pinned version N keeps N after a newer version is accepted or the profile is disabled.

**Fail closed.** An agent bound to a profile never runs without it. A missing profile, a disabled
one that the run has not pinned, a missing version row, or a snapshot that no longer reproduces
its content hash raises a non-retryable `PROFILE_UNAVAILABLE` or `PROFILE_INTEGRITY` failure.

**Bundles do not carry the binding.** Export omits `harnessProfile`; install never touches it on an
existing agent and a newly installed agent starts with none.

## 9. What runs in the container

The Claude Code runtime is the one runtime that loads a profile. Every place a Claude Code runtime
is built for an agent bound to a profile resolves it first (`resolveProfileForRuntime`, which
calls `resolveHarnessProfile` and so fails closed) and passes the verified snapshot to the
runtime's options: the implementer family (`buildImplementerTurnRunner`), agent runs
(`runAgentTask`) and `agent` nodes with a workspace (`runAgentNode`). Resolution happens before the
container is created, so a profile that cannot be resolved costs no clone.

**Where it goes.** The files land under
`/workspace/.harness/profiles/<first 12 hex of contentHash>/`, beside the harness binary and outside
the checkout, so `git add -A` never sees them. The worker builds the snapshot into one ustar archive
in memory (`buildProfileTar`): every directory at mode 0755, every file at 0644 (0755 for an
executable), all owned by root, no link, device or other special entry, so nothing is group- or
world-writable and nothing carries setuid, setgid or the sticky bit. Every path is checked again
when the archive is built (an unsafe or duplicate path is refused, and so is one that does not fit
ustar), the archive is written to a private temporary directory (mode 0700) that is removed whether
the copy succeeded or not, and the workspace backend's `copyIn` hands it to the container (under
Docker the daemon extracts it, `docker cp - <container>:<dir>`; no binary in the container reads or
writes the archive; under Kubernetes the worker validates the archive first and the pod's own `tar`
extracts it). File contents are never logged.

**Written again before every turn, never checked in the container.** The agent can run as root in
its own container, so anything the container reports about its own files can be made to report the
honest answer: it can shim `find` and `sha256sum`, and a process it detached from the turn (`env -u
AUTO_SWE_EXEC_ID setsid ...`) escapes the turn's exec-tag kill and survives to rewrite plugin files
after a check. So the runtime does not verify the copy. Before EVERY turn it:

1. stops every process in the container except PID 1 and the keeper (`killStrays`, the same sweep
   the credentialed git calls use, whatever environment the process was started with);
2. runs one root script that never follows a link: a symlink (or any non-directory) at the profile
   directory or at `/workspace/.harness/profiles` is removed with `rm -f`, the profile directory is
   emptied and recreated as a real directory, and a link or non-directory in place of
   `/workspace/.harness` itself is removed and fails the turn (the binary and its home live there);
3. has the daemon extract the archive into the fresh directory;
4. asserts that the physical path of `/workspace/.harness`, the profiles directory and the profile
   directory (`cd -P` and `pwd -P`) each equal the expected path, and otherwise fails the turn with
   a non-retryable `PROFILE_INTEGRITY`.

The harness is started only after this. The plugin paths it is given are always inside the profile
directory, so a link cannot send it to a checkout or any path outside `/workspace/.harness`. Stray
processes that an earlier turn left running are therefore stopped at the start of the next turn of a
profiled run. The rewrite took about 320 ms for a seven-file profile on the Docker suite's machine
(sweep, two scripts, one extraction); it does not grow per file, because the archive is one
transfer.

This is defence in depth, not a hard guarantee. It makes the cheap attacks fail (a replaced file,
an extra file, a loosened mode, a link into the checkout, a detached process that rewrites the
profile) and keeps plugin hooks, skills and scripts from changing between turns. It does not stop
code that runs during a turn from changing the files within that turn, and an agent running as root
in its own container can shim container tooling generally. Repository-supplied `.claude` hooks
already run in the container with the same authority, so tampering with the profile adds no
capability beyond them.

**Plugins.** Each plugin in the manifest is passed to the SDK as
`plugins: [{ type: 'local', path: '<directory>/<plugin>', skipMcpDiscovery: true }]`. The SDK puts
them on the harness's command line (`--plugin-dir-no-mcp <path>`) and the custom spawn hands that
command line, unchanged, to the binary started in the container, so the paths are read there. A
plugin's commands, skills, sub-agents and hooks load; its MCP servers do not (`skipMcpDiscovery`,
and `strictMcpConfig` stays on). Everything else the worker sets is unchanged: the policy
settings layers, `managedSettings`, the worker-side hooks, the `canUseTool` deny, `permissionMode`,
the pinned API host and the tool allowlist rule.

**Instructions.** The `instructions` file is appended to the system prompt, after the caller's
prompt and skills, behind a provenance line:

```
[profile: <name>@<version> sha <first 12 hex of contentHash>]
<instructions text>
```

The text is approved but still data: it is appended as written and never interpreted. A text
that itself spells a line starting `[profile:` is refused (non-retryable `PROFILE_INTEGRITY`)
rather than edited, so it cannot pass its own words off as the worker's line. The check is made on
a normalized copy: NFKC (full-width brackets and letters fold to ASCII), case-folded, invisible
characters dropped, CR, LF, CRLF, VT, FF, NEL, LS and PS all counted as line breaks, leading white
space ignored, and white space allowed inside the marker. The profile text
counts toward the 100,000-character limit for an inline prompt; a prompt past it is staged as a
file in the container, as before.

**Tools.** A profile's `tools` add exactly those built-ins to the SDK's `tools` list and to the
policy's allowlist, from one list so the two cannot disagree. Only `Skill` and `Agent` can be added;
`WebFetch`, `WebSearch` and anything else stay refused by the worker's policy whoever asks, a plugin
sub-agent definition that lists them included. A call to a tool outside the allowlist is denied.
`Skill` and `Agent` have no file or shell effect of their own and are allowed when granted, within
these limits:

- `Skill` runs only a skill or command the profile's own plugins declare, in the plugin-qualified
  spelling `<plugin>:<name>` (`skills/<dir>/SKILL.md`, by directory name or front-matter `name`;
  `commands/<path>.md`, a subdirectory becoming `<dir>:<name>`; the plugin is its `plugin.json`
  name). The set is computed on the worker from the stored snapshot. A bare name is refused because
  a repository's own skill or command could answer to it; so are bundled skills, the repository's
  `.claude/commands/*.md` (whose `!` lines run shell commands when the command is invoked) and
  repository skills.
- `Agent` must state `run_in_background: false` (the SDK runs a sub-agent in the background unless
  told not to), and is refused when it sets `model` (the model proxy meters only the model it is
  asked for), `name` or `team_name` (they address or detach it), `isolation` (including a remote
  one), or a permission `mode` other than the default.

**Sub-agents.** The `PreToolUse` hook the worker registers also fires for a sub-agent's tool calls:
its input carries an `agent_id` (and `agent_type`) beside the tool name and input. Those calls go
through the same `decideToolCall` as the main agent's, with the same confinement to the checkout, the
same scanners and the same allowlist. The Docker suite starts a sub-agent from a mock model and
shows its denied command in the trace.

**The harness directory is not writable through policy.** A `Write` or `Edit` whose path (resolved
against the harness's current directory when relative, with `..` collapsed) falls under
`/workspace/.harness`, and a `Bash` command with a write target under it, are refused with the
sensitive-file tag. The write targets are the ones the shell scanner extracts (redirects, `tee`,
`dd of=`, the destination of `cp`/`mv`/`install`), with `~` expanded to the harness's home; a
command that names `.harness` at all and also uses a command that changes files or runs code
(`rm`, `sed`, an interpreter, any redirect) is refused too. Reads of the profile's own directory are
allowed (plugins must be readable); nothing else under `/workspace/.harness` is readable through
the `Read`, `Glob` and `Grep` tools.

**Recorded.** An `agent.profile` activity event, once per runtime, carries the profile name,
version, the first 12 characters of the commit sha and content hash, the plugin directories and the
granted tools. Each `harness_turn` transcript record carries `profile` (`name`, `version`,
`contentHash`, `commitSha`), absent for an agent with no profile.

**Other runtimes.** A profile is bound only to agents whose runtime is `claude-code`, but an agent
can still run on another loop: the run's runtime pin, an eval override, or a surface with no
workspace (`runAgentNode` without a workspace, which always runs on Mastra) puts it on Mastra or Pi.
That is not an error. The run proceeds without the profile and an `agent.profile_not_applicable`
event names the agent, the profile, the runtime it resolved to and the loop it ran on.

## Limitations

- **Global and admin-only.** There is no team or organization scope and no delegation of approval.
- **Plugin MCP servers are ignored.** A plugin's `.mcp.json` is stored and shown in the preview but
  never used at run time.
- **Hooks and scripts run in the container.** The scanners are advisory pattern checks, not a
  sandbox or a proof of safety; approval is a human reading the files.
- **The snapshot is not re-verified against the repository after approval.** What was approved is
  what runs, even if the repository later changes or is deleted; picking up a change is a new
  preview and accept.
- **A profile is not tracked.** Nothing polls the ref for newer commits; an administrator asks with
  `preview-update`.
- **Bundles do not carry profiles or the binding.** Export and install of bundles leave both out; a profile is
  approved, and bound to agents, separately on each deployment.
- **No inheritance of the binding.** Personas that inherit a model do not inherit the profile; each
  agent version is bound explicitly.
- **Binding is editable only in the platform-wide agent form.** The per-team override form shows an
  agent's profile read-only; an ADMIN binds it there with `harnessProfile` on the agent library
  routes, or in the platform-wide library form.
- **Stored file content is not reviewable on the page.** File text is read from a preview of a
  commit (add, check for update); a stored version shows its file list and warnings only.
- **A commit sha does not prove branch membership.** A raw sha can name a commit that exists only
  in a fork of the repository, because GitHub serves fork commits through the parent. The recorded
  `owner/repo@sha` says where the content was read, not that the commit is on the repository's
  branches.
- **Names are not reusable.** A profile cannot be deleted or renamed, so its name stays taken. Uniqueness ignores case and is enforced by a database index on `lower(name)`.
- **Plugin hooks and scripts run in the container with the agent's authority.** The scanners at
  approval are advisory, and the worker's policy decides tool calls, not what a hook or script does
  once it runs. The user the harness runs as can do whatever that user can in its container.
- **Protection of the profile directory is a tripwire plus a rewrite, not a boundary.** The policy
  refuses writes under `/workspace/.harness` by path and by command text, which a determined agent
  with arbitrary `Bash` can evade (an interpreter, an encoded path, a variable) and which does not
  stop a plugin script that runs on its own. Behind it the profile is stopped-and-rewritten from the
  worker's snapshot before every turn (§9), so a change made between turns does not survive to the
  next turn. A change made during a turn, by a hook or by a process the agent starts, takes effect
  within that turn. An agent running as root can also replace tools and files other than the
  profile. The directories are created by `mkdir` inside the container and are owned by root, so a
  root-owned agent can unlink and replace the files in them; file ownership does not protect them
  on either backend.
- **A plugin hook can change a call after the worker allowed it.** The binary applies a plugin
  `PreToolUse` hook's `updatedInput` after the worker's `PreToolUse` hook has allowed the call, so
  the tool runs the input the plugin produced while the worker decided the original (the Docker
  suite shows a plugin rewriting a `Bash` command and the rewritten command running). Only an
  approved plugin can do this, never the agent or the repository, and the hook already runs in the
  container with the agent's authority. Possible mitigations, none built: refuse a `PreToolUse`
  hook that returns `updatedInput` at approval (it is visible in the preview), compare the executed
  input in the `PostToolUse` hook with the decided one and record or fail on a difference, or order
  the worker's hook after the plugins'.
- **Disabling a profile is not a kill switch for runs that pinned it.** A pinned version keeps
  resolving after the profile is disabled, and the run-start upsert in `activities/templates.ts`
  keeps the pins of a run across re-executions of the same workflow. A disabled profile stops new
  runs from resolving it and from being bound to it; it does not stop a run that already pinned
  it, nor a retry of that run. To pull a profile from running work, cancel those runs, or bind the
  agents to a different profile, and approve a new version.
- **Plugin MCP servers stay off.** Both `skipMcpDiscovery` and the strict MCP configuration keep a
  plugin's MCP servers out; the only MCP server is the agent's own connection, relayed from the worker.
- **`Skill` and `Agent` widen what the model can attempt.** They add no file or shell capability, but
  a sub-agent is another conversation with its own prompt, and a skill is more text in the
  conversation. Every tool call either makes is still decided by the worker's policy, but the policy
  sees a call, not the conversation that led to it.
- **Sub-agent coverage depends on the harness firing the hook.** The worker relies on the harness
  calling `PreToolUse` for a sub-agent's tool calls. It does so in the SDK's default mode, as the
  Docker suite shows; the SDK documents the `agent_id` field for it. A mode of the harness that ran
  sub-agent tools without the hook would bypass the policy for them, and the `canUseTool` deny and the
  policy settings layers would be the only remaining control.
- **Not applied on other runtimes.** Mastra, Pi and any surface with no workspace run the agent
  without its profile (`agent.profile_not_applicable`); nothing emulates plugins or instructions
  there. The other `runAgent` callers (channel turns, memory passes, workflow authoring) always
  run on Mastra and do not report it.
- **Every turn costs a sweep, two scripts and one transfer.** The profile directory is written
  again each time, whatever it held, and stray processes from an earlier turn are stopped at the
  start of the next one, so a server an agent left running in a profiled run does not outlive the
  turn that started it.
