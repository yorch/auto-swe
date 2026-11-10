# Maintenance and document workflows

Three built-in templates cover recurring upkeep work. Each ends at something a person looks at
before it matters: a draft pull request, or a proposal that waits for approval. None of them
merges anything.

| Template | Starts from | Writes | Ends at |
|---|---|---|---|
| `docs-refresh` | A repository schedule, or by hand | Markdown files in a git repository | A draft pull request, or nothing when the docs are current |
| `vulnerability-remediation` | A request that carries an advisory | Dependency manifests, lockfiles and the code a breaking change forces | A draft pull request, with CI repaired up to three times, or nothing when the repository is not affected |
| `confluence-review-to-tickets` | A Confluence page id, started by hand or from an event | Comments on the page, then an epic, tickets and sub-tasks in Jira | Comments (the page is not ready), or created tickets (a person approved the structure) |

They are ordinary templates: clone one to change a prompt, a gate or a limit, and launch it the
way any template is launched ([product-overview.md](./product-overview.md) lists the entry
points).

## 1. Documentation refresh

`docs-refresh` keeps a repository's markdown true to its code, or writes it when it does not exist.
The implementer runs under the `docsMaintainer` prompt: find the documentation, read the code each
page describes, check every concrete claim (file names, commands, flags, configuration keys,
endpoints, defaults, examples) against it, fix what has drifted, add what is missing, and change
nothing when nothing needs to change. A repository with no documentation gets a README and, only
where a README cannot hold the content, pages under `docs/`.

**Launching.** Put it on a repository schedule (a `ScheduledWorkRequest` naming the template, see
[repositories.md](./repositories.md)) for a weekly recheck, or start it by hand. The run's
description is the focus: "the API reference" or "installation and configuration". With no focus it
looks at all the documentation.

**What confines it.** The implementation step carries `allowedPaths` of `**/*.md` and `docs/`. After
the agent commits, the worker compares the committed tree with the commit the session started from
and fails the step, before anything is pushed, on any path outside those entries. The prompt says
the same thing, and the guard is what holds when the prompt does not. An entry may be a file
(a path from the repository root), a directory by a trailing slash (`docs/`), or an extension (`**/*.md`); it is not a
pattern language, and any other wildcard matches only itself, so a mistyped entry narrows the guard
([model-configuration.md](./model-configuration.md) describes the check).

**Ending.** A run whose diff is empty ends `SUCCESS` with `changed: false` and opens nothing. Otherwise
it opens a **draft** pull request and ends: there is no CI loop and no approval step inside the run,
and a person merges.

**Without a template.** The same prompt is the seeded `docsMaintainer` agent, so
`auto-swe agent run docsMaintainer "<focus>" --repo <org/name> --deliver draft_pr` does one pass on
demand through an [agent run](./agent-runs.md). That path has no markdown-only guard: its push policy
is the general one, and the prompt alone asks the agent to keep to documentation.

## 2. Vulnerability remediation

`vulnerability-remediation` patches a reported vulnerability. The advisory arrives in the request:
the affected package, the vulnerable and fixed versions, the severity and an identifier. No event
source reads a vulnerability alert from GitHub or a scanner directly; the request comes one of
three ways.

- **A ticket.** A Jira ticket reaching a Jira filter automation, or a hand launch, carries the
  advisory in the run's description, as the ticket or the person wrote it.
- **An inbound event.** A scanner or a relay posts the advisory to a team's event endpoint, and an
  `inbound.event` automation on that endpoint starts this template with its `fields` mapping
  pointing the template's advisory inputs at the event's body ([inbound-events.md](./inbound-events.md)
  §4). The automation must name the repository its runs act on (`targetConnectionId`): the
  template requires a `connectionId`, so an automation without one is refused when it is saved.
- **By hand, with the inputs filled.** The run form shows the advisory inputs and checks them
  against their types, but the implementer reads the run's description and not the other inputs,
  so a hand launch writes the advisory into the description as well.

| Input | Type | Meaning |
|---|---|---|
| `packageName` | string | The affected package, as its package manager names it |
| `vulnerableVersions` | string | The affected version or range, such as `<4.17.21` |
| `fixedVersions` | string | The version or versions that fix it, such as `4.17.21` |
| `severity` | `critical`, `high`, `medium` or `low` | The advisory's severity |
| `advisoryId` | string | A CVE, GHSA or scanner identifier |

All five are optional, and an event can fill each of them. The four strings are bounded in length
and in alphabet, with no space allowed: `packageName` up to 214 characters of letters, digits and
`@ . _ / : + ~ -`; `vulnerableVersions` and `fixedVersions` up to 128 characters of letters, digits
and `. , < > = ~ ^ * + : _ | -` (`vulnerableVersions` also `! [ ] ( )`); `advisoryId` up to 64
characters of letters, digits and `. _ : -`, starting with a letter or digit. A value outside its
bounds fails the run's input check, and the event is recorded `FAILED_TO_START`. The template also takes the SWE inputs
(`ticketId`, `connectionId`, `description`, `budget`); an automation never maps `ticketId`,
`description` or `connectionId` from an event. There is no title, summary or URL
input: those are free text the sender writes, and the identifier names the advisory.

On an event-started run, the mapped values reach the implementer inside the run's description, as
one JSON object under a line that says the event's text is the sender's and is data
([inbound-events.md](./inbound-events.md) §4). The remediation prompt names the five fields, says
their values are the sender's, and has the agent check the package and its versions against the
repository and the package's registry before acting on them.

**The run.** The implementer runs under the remediation prompt: find where the package is declared and
which version resolves, choose the lowest fixed version, change it with the repository's own
package manager so the lockfile moves with the manifest, read the release notes for breaking
changes and adapt only what affects this repository, and run the tests. It does not add a
dependency, loosen a version constraint, or suppress the advisory, and it does not force a major
version bump: it makes no change and explains the options.

After the change the run scans for vulnerabilities, runs the full test suite, opens a **draft** pull
request, and repairs CI failures from the logs and pushes, up to three times. The scan and the
tests record their result and do not stop the run; the draft pull request and CI are the checks.

**Not affected.** A repository whose resolved version is already fixed, or that does not use the
package, ends `SUCCESS` with `changed: false` and opens nothing.

## 3. Confluence review to Jira tickets

`confluence-review-to-tickets` reviews a page against criteria and, when it is ready, turns it into
Jira tickets a person has approved.

| Input | Meaning |
|---|---|
| `connectionId` | The Confluence connection the page is read from and the comments are written to |
| `pageId` | The page to review |
| `trackerConnectionId` | The issue tracker connection the tickets are created in |
| `criteria` | What the page is reviewed against. Without it the reviewer uses a general rubric: goal and audience, scope and non-goals, specific testable requirements, named dependencies and open questions |
| `instructions` | Extra guidance for both agents, such as conventions or size limits |
| `projectKey` | The Jira project; the connection's default when blank |
| `epicIssueType`, `storyIssueType`, `subtaskIssueType` | Issue type names for a project that does not call them `Epic`, `Story` and `Sub-task` |

**The flow.**

1. The `docReviewer` agent reads the page and returns a verdict and findings as JSON. Each finding
   has a severity (blocker, major, minor, nit), the section, a short verbatim excerpt and what would
   fix it.
2. Code checks that reply. A reply that is not the expected JSON ends the run `FAILED` before anything
   is written. A review that lists a blocker or a major finding is never ready, whatever the agent
   said.
3. The findings are posted to the page as comments, through the autonomy policy: under the default
   policy a person approves them first. A finding with an excerpt that appears in the page text is
   anchored to it; one with no excerpt, an excerpt that is not found, or one Confluence refuses to
   anchor goes at the foot of the page with the excerpt quoted. A verdict comment comes first.
4. A page that is not ready ends here with `ready: false`. The author fixes it and the run is started
   again; the comments are the feedback.
5. A ready page goes to the `ticketPlanner` agent, which proposes one epic, the tickets under it,
   and sub-tasks where a ticket has distinct steps. Code checks that reply as well.
6. A person reviews the structure. They approve it, reject it, or request changes with a note, which
   goes back to the planner. After three requests for changes the run ends `FAILED`. Nobody answering
   for 72 hours ends it `TIMED_OUT`.
7. Creating the tickets is an external write and goes through the autonomy policy again, so an
   operator who requires an approval for external writes sees a second, separate approval. The
   structure review is a person whatever the policy allows.

**Creating the tickets.** The epic is created first, each ticket under it, and each sub-task under its
ticket, with the issue types above (Linear has no issue types and nests by parent). A ticket's
acceptance criteria are appended to its description. Creation is sequential and not
transactional: a failure part way leaves what was created, and the failure names every issue
created so far without quoting the tracker's text. The write is recorded once, so a retry does not
create them twice, and a failure that may have reached the tracker refuses to be retried blindly.

**What a model cannot widen.** Both agents' replies are parsed and validated in code. A review holds
at most 50 findings, a plan at most 40 tickets and 10 sub-tasks on any one, and the plan is
validated again by the write itself. The page text is untrusted: both prompts treat it as data,
and the text posted back is escaped storage, never markup.

## Limitations

- **Vulnerability scanning covers Node repositories only.** `runVulnScan` has a default command for
  npm, pnpm and Yarn Berry. Python, JVM and Go have none, and their audit tools read vulnerability
  data from hosts the registry proxy does not relay ([package-registries.md](./package-registries.md)),
  so their scan gate resolves as unconfigured and the run relies on tests and CI.
- **No scanner is a built-in event source.** The advisory arrives as a ticket, an inbound event or a
  hand launch. Snyk is wired through an event endpoint ([inbound-events.md
  §6](./inbound-events.md#6-recipe-snyk-to-vulnerability-remediation)); GitHub Dependabot and code
  scanning alerts are not an event source.
- **The advisory inputs are checked for alphabet and length, not meaning.** `severity` takes one of
  four values; each string is limited to the characters and length in §2. That keeps a sentence out
  but not a plausible-looking wrong value: nothing checks that `packageName` names a package the
  repository uses or that a version exists. A range that needs a space (`>=1.0.0 <2.0.0`) is
  refused; write it with a comma or leave the field unmapped. The prompt's instruction to check the
  values against the repository and the registry is what stands between a wrong or crafted value
  and the change.
- **A severity on another scale fails the start.** A sender that says `moderate`, or uses upper case,
  fails the template's input check, and the event is recorded `FAILED_TO_START`. Leave `severity`
  unmapped for such a sender.
- **One event, one advisory.** A mapped field is a single value, so an event that lists several
  findings starts one run for the values its pointers name; the others are not read.
- **An inbound event's run needs a repository named on the automation.** One endpoint automation
  acts on one repository, so a scanner that reports for many repositories needs an automation per
  repository, each matching that repository's events.
- **A hand launch's advisory inputs do not reach the implementer.** It reads the description only.
- **`docs-refresh` runs the implementer's test loop.** The step runs the repository's tests as it does
  for code. A documentation-only change that fails unrelated tests ends that loop at its limit and
  the run carries on, with the result recorded; the guard still stops it editing anything but
  documentation.
- **Documentation accuracy is the agent's reading of the code.** The reviewers of the draft pull request
  are the check; no step executes the documented commands.
- **Inline comments are best effort.** The anchor is matched against the page text as the connector
  reads it, which can differ from what Confluence indexes around tables, macros and formatting. A
  comment that cannot be anchored is still posted at the foot of the page. The inline-comment and
  footer-comment calls have not been exercised against a live Confluence site.
- **A page is reviewed as text.** Images, diagrams and macro content are not read.
- **The review does not repeat on its own.** A not-ready page is re-reviewed only when the run is
  started again, and each run posts its own comments; earlier comments are not read, resolved or
  deduplicated.
- **Ticket creation can stop part way.** A failure after some issues exist leaves them in the tracker,
  named in the failure, for a person to remove or adopt.
- **Story points and links are not set.** Tickets carry a title, a description with acceptance
  criteria and a parent; estimates, labels, components, assignees and issue links are not.
