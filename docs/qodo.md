# Qodo integration

Qodo reviews pull requests with its own bot and publishes what it found through an MCP server. A
team can connect that server to auto-swe as an ordinary `mcp` Connection. The platform reads Qodo's
review of a pull request; it never asks Qodo to write anything.

## 1. Connection setup

A team's Qodo connection is an `mcp` Connection with these properties:

- **URL** — the tenant's Qodo MCP endpoint, for example `https://sdk.qodo.ai/v1/tools/mcp/`. The
  trailing slash is required: MCP connections do not follow redirects, so the slash-less form is
  refused.
- **Credential** — the Qodo API key, sent as a bearer token.
- **Marker** — `config.integration: 'qodo'`. The marker is what makes it the team's Qodo connection,
  and it implies result screening and the read-only allowlist below.
- **Allowlist** — `config.allowedTools`, set through the API only; the `/mcp` page shows the size of
  a stored list and offers no way to edit it. A marked connection with no stored list
  gets the read-only list, so it cannot bind unfiltered. A stored list on a marked connection can
  only narrow it: the gateway answers `400 QODO_WRITE_TOOLS`, naming the tools, when a create or an
  edit leaves a name outside the read list in the marked connection's list (including an edit that
  sets the marker on a connection whose stored list already has one), and the worker intersects a
  stored list with the read list when it binds, so a row written any other way still binds no write
  tool.

Setting the marker or the allowlist is ADMIN-only. Removing the marker (`integration: null`) is an
audited admin decision that removes the Qodo guard with it: the connection is then an ordinary
`mcp` connection, its stored list is read as written and its results are screened only if
`scanResults` is set.

The `/mcp` page sets the marker and screening with two checkboxes in the create and edit forms,
"Qodo integration" and "Screen tool results". Ticking Qodo checks the screening box and locks it,
because a marked connection is always screened. The edit form sends a policy field only when it
differs from the stored value, so saving without touching the boxes changes neither; clearing the
Qodo box on a marked connection sends `integration: null` and shows a warning that the read-only
guard goes with the marker and that results are no longer screened unless the screening box stays
ticked. A marked connection carries a "Qodo" badge in the list, and a stored custom tool list
appears as a read-only count. A `400 QODO_WRITE_TOOLS` answer shows its message in the form's alert.

The connection test (`POST /api/v1/platform/mcp-connections/:id/test`, which lists tools and calls
none) also reports, for a marked connection, a `qodo` object with `matchedReadTools` (how many
advertised tools are on the read list), `findingsToolAdvertised` (whether `get-pr-review-findings`
is advertised) and a `warning` when none match. The `/mcp` page shows these three under the test
result and shows nothing Qodo-specific for an unmarked connection.

Run the test after creating the connection: the read list uses the Qodo CLI catalog's names, and a
server that advertises them differently would bind nothing. `resolveQodoConnection({ teamId })`
returns the oldest active Qodo connection the repository's team owns, or nothing. No template,
agent or run input names a connection, and another team's connection is never returned.

## 2. Read-only guarantee

Qodo's catalog has 64 tools: 41 read and 23 write (comments, approvals, labels, rules and notes
changes). `QODO_READ_TOOLS` (`packages/shared/src/lib/qodoConnection.ts`) lists the 41 read tools by
name, audited by hand. A tool Qodo adds later, or reclassifies from read to write, stays out until
the list is edited. The loader binds only listed tools, and for a marked connection whatever list is
stored is intersected with the read list, so a write tool cannot be called through the platform.

## 3. Output screening

Qodo text is untrusted input. Every string value in the result of a Qodo tool call is checked, on
its own, against the injection patterns used by the memory gate and, when clean, fenced as reference
data between `BEGIN UNTRUSTED MCP OUTPUT` and `END UNTRUSTED MCP OUTPUT` lines. A text block that
holds a JSON object or array is screened and fenced string by string inside it, and the
re-serialised JSON is then fenced as a whole, so the block always carries the markers.

Object keys are read by the model too, so each is screened with the same patterns. A clean key
stays as it is (fencing it would break the shape callers parse); a key that matches, or whose scan
is incomplete, is replaced by the placeholder, with a counter suffix when several are replaced so
no value is overwritten. A `type` discriminator is left as it is only when it names a known MCP
content block (`text`, `image`, `audio`, `resource`, `resource_link`); any other value is screened
and fenced like a string. In an image, audio or resource block the encoded payload (`data`, `blob`)
is left untouched, and `mimeType` and `uri` are screened but not fenced, so the block still parses;
the `text` of a resource is screened and fenced as usual.

A string that matches, or whose scan is incomplete, is replaced by the placeholder
`[withheld: failed the injection screen]` and the rest of the result is returned, so one quoted
phrase in one finding does not hide the others. The `mcp.output_blocked` event records how many
strings and keys were withheld (`withheldLeaves`), the pattern names and the reason, never the text.
Only a scan that fails outright withholds the whole result. See [`agents.md`](./agents.md) for the
connection mechanics.

## 4. The shared client and `qodo.enabled`

Features that need Qodo's view of a pull request use one worker-side client,
`createQodoFindingsClient` (`packages/worker/src/lib/qodo/client.ts`), rather than calling the MCP
tool themselves. Its single operation is `getPrReviewState(prUrl)`, which returns one of:

| State | Meaning |
|---|---|
| `ok` | Qodo reviewed the PR: the session (run id, status, reviewed commit SHA, start time), the findings, the reported finding count, a `truncated` flag, a count of findings with an unrecognised status, and `withheldFields`, the number of strings the result screen replaced with its placeholder |
| `no_session` | Qodo has not reviewed the PR |
| `unavailable` | The state could not be read, with a fixed reason: `disabled`, `not_configured`, `connection_refused`, `tool_missing`, `call_failed`, `bad_response` or `timeout` |

The client never throws, and a reason is a fixed string: no error text, URL, header or response body
is ever put in it. It validates that the PR URL is an `https` URL with a `/pull/<n>` path, calls only
the `get-pr-review-findings` tool with `{ pr_url }`, bounds the result to 50 findings with titles up
to 200 and descriptions up to 2000 characters, strips control characters, and closes the MCP client
when done. A finding whose title or description was withheld is still a finding: it is listed and
counted with the placeholder text, and the severity and status fields it is counted by are not text
a withheld phrase can hide. The caller passes its tracer, so the MCP loader's events
(`mcp.output_blocked`, `mcp.connect_failed`, `mcp.tools_skipped`) land on the caller's trace, which
the caller persists. One read is bounded by the loader's list timeout plus its call timeout plus
5 seconds (80 seconds by default, never above 120), so the loader reports a slow server before the
client gives up. `createFakeQodoFindingsClient` is the scripted test double.

The `qodo.enabled` setting (default off; ADMIN; overridable per team and organization) gates every
read. When on, PR identifiers and the team's Qodo credential are used to read Qodo's review of pull
requests; no source code is uploaded by auto-swe. When off, the client answers `disabled` before it
resolves a connection or touches the network. The team is the run's repository team, so the setting
and the connection are always read for the same team.

### Findings payload

The client reads the default output of `get-pr-review-findings` and ignores fields it does not use:

- `review_session` — `null` when Qodo has not reviewed the PR; otherwise `run_id`, `status`,
  `commit_sha` (the commit Qodo reviewed) and `started_at`.
- `findings[]` — `id`, `title`, `description`, `category`, `action_level`, `attribution_status` and
  `finding_source`.
- `finding_count` — the total Qodo reports.

Vocabularies are normalised. Session status is `completed`, `failed` or `other`; action level is
`action_required`, `remediation_recommended`, `informational` or `unknown`; attribution status is
`pending`, `implemented`, `dismissed` or `unknown`. Only `pending` counts as an open finding
(`isOpenFinding`); a finding with an unrecognised status is never open, and the number of them is
reported on the result so a caller can record it. `actionLevelAtLeast` orders `informational` below
`remediation_recommended` below `action_required`.

## 5. Fixing Qodo's findings

An automation on the `github.pull_request.feedback` source that lists the `qodo_findings` trigger
makes the platform address the open findings of Qodo's review of a pull request it opened. The bot's
GitHub comment only triggers a round; the findings are read through the client in section 4, for
the repository's team, and a round proceeds only when Qodo's completed review is of the pull
request's current head commit. The settings are:

| Setting | Default | Effect |
|---|---|---|
| `qodo.enabled` | off | Gates every read of Qodo |
| `qodo.prFeedbackBotAccountIds` | empty | Numeric account ids of Qodo's bot on this GitHub host; empty keeps the trigger inert |
| `qodo.prFeedbackMinActionLevel` | `remediation_recommended` | Lowest finding level addressed |
| `qodo.prFeedbackMaxRounds` | 2 | Pushed rounds Qodo alone may cause on one pull request |
| `qodo.prFeedbackWaitSeconds` | 120 | How long a round waits for Qodo to finish reviewing the head |

Find the bot's id once on the host (for GitHub, `GET /users/<bot login>` returns it as `id`) and
save it under Admin > Platform settings; the id, not the login, is matched. The round, its limits,
what reaches the model and what safety it does and does not have are in
[pr-feedback.md §8](./pr-feedback.md#8-qodo-findings).

## 6. Waiting for Qodo's review in a workflow

The `awaitQodoReview` step waits for, then reads, Qodo's review of the pull request a run just
opened, so a template can route on how serious it is. It does not ask Qodo to review anything: it
reads what Qodo's own pull-request bot produces, through the client in section 4. The node contract
and a worked example are in [workflow-nodes.md](./workflow-nodes.md#wait-for-qodos-review-of-the-pull-request).

**Whose credential.** The step takes no connection and no team. It reads the run's repository
record and calls the shared client for that repository's team, so the connection, the
`qodo.enabled` switch and the access check in `resolveQodoConnection` all belong to the same team.
A global or bundle template can therefore never spend another team's Qodo credential, and nothing a
template, node config or input says can redirect the lookup.

**Data egress.** auto-swe uploads no source code. The step sends the pull request's URL, and the
team's Qodo credential as a bearer token, to the team's Qodo connection, and receives Qodo's review
of the PR.

**Result.** `status` is one of:

| `status` | Meaning |
|---|---|
| `reviewed` | Qodo's session for the pull request completed and covers exactly the `headSha` the node was given |
| `stale` | At the deadline, Qodo's latest review covers a different commit |
| `pending` | At the deadline, Qodo has no review, or its session for this commit is not completed |
| `unavailable` | Qodo could not be read, the session for this commit failed, the run has no repository with a team, or an input is missing |
| `disabled` | `qodo.enabled` is off for the repository's team; returned before any connection lookup or network call |

`reviewedHeadSha` and `headMatches` say what Qodo reviewed. Only a `reviewed` result carries
findings: `counts` (open findings by level, and `open` in total), `worst` (the most serious open
level, or `none`), the open `findings` ranked most serious first (at most 25, each with `id`,
`title`, `description`, `category`, `actionLevel` and `attributionStatus`), and `truncated`, true
when findings were cut by the client's bounds or by the 25 cap. `blocking` is true when a
`reviewed` result has an open finding at `action_required`, including one whose text was withheld.
`withheldFields` counts the strings of Qodo's answer the injection screen replaced with a
placeholder; the step records it, with `status` and a fixed reason, in a `qodo.review_outcome`
activity event on every run, and records a `qodo.read_unavailable` event with the client's reason
when Qodo could not be read. "Open" is the client's rule: an
attribution status of `pending`; an unrecognised status or level is never open and never blocking.
The result has no `passed` field, so the interpreter never reads it as a failed quality gate.

**Waiting.** The node's `waitSeconds` (a whole number; 0 reads once) defaults to the
`qodo.reviewWaitSeconds` setting and is capped at 600. The step sleeps up to 10 seconds between
reads, so 10 seconds is a lower bound on the spacing: each read can itself take up to the read
budget in section 4. It heartbeats until the review of the head commit completes or the wait ends,
and its activity timeout (15 minutes) exceeds the longest wait plus one full read. It runs as a single
attempt with its own timeout, never the shared retry policy, and never throws: a failure is an
`unavailable` result carrying no error text. `minActionLevel` drops open findings below a level
from the counts and the list. A PR with no Qodo review at all is indistinguishable from one Qodo
has not started yet, so it is waited on like one and ends `pending`.

**It blocks nothing by itself.** The step only reports. A run is held back by Qodo only when the
template routes on `blocking` or `status` (for example `cond` to a human decision), and a
template that routes on `blocking` alone lets `pending`, `stale`, `unavailable` and `disabled`
through. Route on `status` as well to fail closed: the `qodoReview()` authoring helper takes
`failClosed: true` for this, which routes `status != 'reviewed'` or `blocking == true` to the
blocked branch.

**Cost on a repository without the Qodo bot.** A template carrying `awaitQodoReview` spends up to
`qodo.reviewWaitSeconds` (default 180) and repeated MCP reads on every run of a repository that does
not have the Qodo PR bot, then reports `pending`. Setting the wait to 0 turns the step into a single
read.

The findings are third-party text: bounded and screened as in sections 3 and 4, but still
untrusted. A template must not put them into an agent prompt unfenced.

| Setting | Default | Effect |
|---|---|---|
| `qodo.reviewWaitSeconds` | 180 | Wait used by a node that sets no `waitSeconds`; 0 to 600; overridable per team and organization |

## Limitations

- The `awaitQodoReview` step makes one wait per node, reads a single pull request, and cannot start
  a review: it works only where Qodo's PR bot is installed, and on a repository without it every
  run spends the whole wait before reporting `pending`. Set `waitSeconds` to 0 to read once.
- Its findings are third-party text, and a result is only as current as the commit it names:
  `reviewed` means Qodo's review covers the head SHA the node was given, not that nothing has been
  pushed since.
- Qodo's review bot must be installed on the repository. Without it a PR has no review session and
  the client reports `no_session`.
- Qodo cannot be asked to start a review over MCP. The platform can only read a review that Qodo's
  bot has already produced.
- The payload shape and the status and action-level vocabularies were observed, not specified by
  Qodo. A value the client does not know degrades to `other` or `unknown`; a response that no longer
  matches the observed shape reads as `bad_response`.
- A review runs asynchronously, so a read made right after a push can describe an earlier commit.
  Compare the session's `commitSha` with the PR head.
- At most 50 findings are returned per read, and a `truncated` result has lost text or findings.
- The tool allowlist is maintained by hand against Qodo's catalog, using the names the Qodo CLI
  catalog gives. Nothing here confirms the MCP server advertises the same names: if it namespaces
  them, the allowlist binds nothing and every feature reads as `connection_refused` or
  `tool_missing`. Confirm against the connection test's `qodo` object.
- Result screening can withhold legitimate text that resembles an injection pattern. Only that
  string is replaced, so the read still succeeds; the finding is counted with placeholder text, and
  a round that fixes findings drops it. A scan that fails outright still reads as `bad_response`.
- The screen sees each string alone, so an injection phrase split across two fields is not matched.
