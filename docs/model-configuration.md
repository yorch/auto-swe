# Models and credentials

> How LLM model selection and provider credentials work in auto-swe.

The DB is the sole source of truth for LLM config — no env vars for models or API keys. The worker calls `assertConfigReady()` at boot and refuses to start until the required rows exist. All edits go through `/studio/models` (admins) or `/teams/<id>` (team owners).

---

## Concepts

### Scopes

Per-role model + system-prompt config lives on the first-class `Agent` table. Every `Agent` row lives at one of five scopes:

| Scope | Discriminator | Purpose |
| ----- | ------------- | ------- |
| `GLOBAL` | none | System-wide default. Exactly one row per role. |
| `ORGANIZATION` | `orgId` | Overrides GLOBAL for runs owned by teams in one org. |
| `TEAM` | `teamId` | Overrides ORGANIZATION + GLOBAL for runs owned by one team. |
| `CHANNEL` | `channelId` | Overrides TEAM for channel-resident runs only (Slack channel assistant). |
| `WORKFLOW_TEMPLATE` | `workflowTemplateId` | Overrides all lower scopes for runs of one template. |

Per-role model selection lives on `Agent.modelSpec` (`<provider>/<model>`); sub-roles can carry `Agent.inheritsModelFrom` instead to bind a parent role's model, and `Agent.credentialId` pins a specific credential. The resolver picks the most specific scope row that exists for a given call:

```
WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL → ConfigMissingError
```

A missing GLOBAL row is a startup error, not a runtime condition — `assertConfigReady()` at worker boot catches it before any activity runs.

`ProviderCredential` rows are scoped `GLOBAL`, `ORGANIZATION`, or `TEAM` — enforced by a DB CHECK, so there is deliberately no channel- or template-level credential tier. Credential resolution cascades `TEAM → ORGANIZATION → GLOBAL`. Templates and channels that want to pin a specific credential do so via `Agent.credentialId` pointing at one of those rows. The singleton `EmbeddingConfig` row covers the system-wide embedding model — no scope cascade (only one embedding role in the system).

**Pinned credentials.** When an agent version carries `Agent.credentialId`, its model is called with that credential instead of the provider-name cascade. A persona with no pin of its own takes the pin of the row it inherits its model from, as it takes the model. Pinning is what lets two agents call the same provider with different keys — two OpenAI accounts, say — without renaming one provider and giving up its native client. A pin is used only when the credential still exists, belongs to the provider the model spec routes to, and sits at a scope the run can reach (GLOBAL, the run's organization, or the run's team). Otherwise the worker logs `agent credential pin not usable` with the reason (`missing`, `provider-mismatch`, `out-of-scope`) and falls back to the cascade.

## Per-scope system prompts

`Agent` has an optional `systemPrompt` field. When set, it replaces the agent's hardcoded system prompt for that scope. The cascade works identically to model selection:

```
WORKFLOW_TEMPLATE → CHANNEL → TEAM → ORGANIZATION → GLOBAL → (use agent's built-in prompt)
```

`systemPrompt` cascades **independently of `modelSpec`**: a higher-scope row may set the model and leave `systemPrompt` null, in which case the search for a prompt continues down the cascade. So a team override can change the model without losing the global default prompt, and vice versa.

The null default (no row has a `systemPrompt`) means the agent uses its built-in prompt unchanged. Setting a prompt at GLOBAL scope overrides it system-wide; a TEAM, CHANNEL, or WORKFLOW_TEMPLATE row can further refine it for a narrower audience.

Common uses:

- **Team-specific persona** — give the implementer agent extra context about a team's coding standards without modifying the built-in prompt.
- **Template-specific reasoning** — add domain knowledge (e.g. "this is a migration workflow; prefer additive schema changes") to a single template's agent.

The sole resolver is `resolveAgent(key, ctx)` in `packages/worker/src/lib/config/agentResolver.ts`, which returns the resolved model, system prompt, skills, and tools for a role in one pass; `getModel` / `getModelSpec` in `packages/worker/src/lib/models.ts` are thin shims over it. Activities bind the model and pass the resolved prompt as the `system` field in `agent.generate()`.

---

### Resolution context

Worker activities pick up `{ teamId, workflowTemplateId }` automatically via `currentRequestContext()`, which joins the Temporal `currentWorkflowId()` against `ActiveWorkflow → repository.teamId` and `WorkflowRun.templateId`. Nothing has to be passed through workflow inputs.

### Encryption

API keys are AES-256-GCM encrypted with a per-record 12-byte nonce. The master key is read once from `CONFIG_ENCRYPTION_KEY` (base64-encoded 32 bytes) at process start. Plaintext keys live in memory only during an in-flight request — they are never logged, never returned in API responses (only a `****<lastFour>` mask), and never persisted in the audit log.

### Caching

The worker keeps a process-local 30-second cache of resolved `Agent`, `ProviderCredential`, and `EmbeddingConfig` rows (`packages/shared/src/config/cache.ts`). Tune the TTL with `CONFIG_CACHE_TTL_MS`. The cache holds decrypted plaintext API keys for its TTL window — if you rotate a credential, expect up to `CONFIG_CACHE_TTL_MS` of lag before workers pick it up.

### Model catalog

`model_catalog_entries` holds one row per `<provider>/<model-id>` spec: its `kind` (`CHAT` or
`EMBEDDING`), input and output price in USD per million tokens, and a `status` (`ACTIVE`,
`DEPRECATED`, `RETIRED`) that governs which models are offered, never whether one is priced. The
catalog is global — prices are facts about a vendor, not per-team policy — and a `0`/`0` row is a
known, free model such as a self-hosted endpoint, distinct from an unknown one.

`syncModelCatalog` seeds it at gateway startup from `BUILTIN_MODELS`
(`packages/shared/src/lib/builtinModels.ts`). Code owns a built-in row until an admin edits it:

| Row state | On each startup |
|---|---|
| Missing | Created as built-in |
| Built-in, untouched | Kept in step with code, so a price corrected in code reaches every deployment |
| Built-in, `isCustomized` | Left as the admin set it |
| An admin's own row for a model that later ships built-in | Adopted as built-in and customized, keeping the admin's prices |

Nothing is deleted: a model dropped from `BUILTIN_MODELS` stays priced for the runs that used it.

**Pricing reads the catalog.** Each LLM and embedding call is priced from its spec's catalog row,
falling back to `BUILTIN_MODELS` when the catalog has none — so a model is priced before the gateway
has seeded the catalog. The lookup is exact: a near-miss such as `gpt-5-5` for `gpt-5.5` is unknown
and priced at $0, never at its neighbour's rate. A row with a negative or non-finite price is
skipped. The worker reads the catalog once per config-cache window, so an edit lands within
`CONFIG_CACHE_TTL_MS`; a call's cost is fixed when it is recorded, so an edit never reprices history.
If the catalog cannot be read, pricing uses the last good read, else the built-in table, and retries
after one window — a pricing failure never fails a call.

**Prompt caching is priced from the usage the provider reports.** A call's input total includes the
tokens it read from or wrote to the provider's prompt cache; those are costed at multiples of the
model's input price, and the rest at the input price. The multipliers come from the model's catalog
row where it sets them — `cacheReadMultiplier`, `cacheWrite5mMultiplier` and
`cacheWrite1hMultiplier`, each nullable and read field by field — and otherwise from the code table
(`cacheMultipliers` in `builtinModels.ts`). Seeding leaves them null on a built-in row, so the table
stays the source for built-ins and a correction to it reaches every deployment; an admin's value
overrides it and a **Reset** clears it. The table gives Anthropic models 0.1× for reads, 1.25× for
5-minute writes and 2× for 1-hour writes, on every Claude spec including catalog-only ones;
`openai/gpt-5` reads at 0.1×. Any other model's cached input is priced as ordinary input unless its
row says otherwise. A negative or non-finite multiplier is ignored. The multipliers scale whatever
input price the catalog holds, so a customized price needs no second edit. The budget tiers still
meter every input token, cached or not.

A cache write is priced at the 1-hour rate only for the part the provider reports as written with
that TTL. Mastra's usage carries it as `cacheCreationInputTokens1h`, lifted from the Anthropic
response's `cache_creation.ephemeral_1h_input_tokens`; the rest of the writes take the 5-minute
rate. The AI SDK's own usage shape carries no TTL split, and a response without the breakdown prices
every write at the 5-minute rate. The span records the counts as `llm.cache_read_tokens`,
`llm.cache_write_tokens` and `llm.cache_write_1h_tokens`.

**In the dashboard**, `/studio/models` → **Catalog** lists every model with its price, status and
source — *built-in*, *customized* (an admin's edit, which startup keeps), or *custom* — and, on a
customized row whose shipped values have since changed, what code now ships beside a **Reset**.
Above it, *Unpriced in use* lists the models configured or called in the last 30 days that nothing
prices, each with its likely intended spec and an **Add to catalog** that prefills it. The agent
and embedding model-spec fields are pickers over the catalog — chat models for agents, embedding
models for the embedding config — showing each model's price; a deprecated one is labelled and a
retired one is not offered.

**Discovering new models.** A scheduled run lists models through each GLOBAL provider credential —
the same list-models endpoints, auth and SSRF guard as the credential **Test** — and stores two
kinds of flag in `model_suggestions`, apart from the catalog: models a provider lists that nothing
prices (*new*), and priced models a provider no longer lists (*possibly retired*). The catalog tab's
*New from providers* shows the new ones with a last-checked time, each provider's error if its
listing failed, an **Add** prefilled with the id, kind and display name, and a **Dismiss**;
**Check providers now** runs the same pass on demand. *Possibly retired* lists the other kind with an
**Edit** that opens the row; nothing retires a model for you. Discovery only suggests, so a
discovered model is not "known" until an admin adds it with a price, and the pricing path never reads
a suggestion.

The run's cadence is environment-only, like the other gateway sweeps: `MODEL_DISCOVERY_ENABLED`
(default `true`) and `MODEL_DISCOVERY_CRON` (five-field cron, UTC, default `17 3 * * *`). The gateway
applies them to the `auto-swe-model-discovery` Temporal Schedule once, at startup, so a change needs
a gateway restart, and it refuses to start on a value it cannot use. Disabled, the schedule stays but
is paused, and **Check providers now** still works.

A provider whose listing fails — a bad key, a timeout, a 200 that is not a model list — is logged,
and its error and last-success time are recorded for the tab; its existing suggestions are left
exactly as they were, and it produces no retirement candidates. The recorded error is always one of a
fixed set of strings (`HTTP <status>`, `timed out`, `request failed (<error name>[, <error code>])`, `blocked
address`, `apiBase required`, `unrecognised response`, `credential could not be decrypted`): Node puts header values and URL userinfo in
its error messages, so no message text from the request or the provider reaches the status row, the
API, the logs or the activity result in workflow history. A listing cut short by
the page cap, one that signals more pages it gives no cursor for, or one that came back empty is
incomplete: it still records new suggestions, but it deletes nothing and flags no retirement
candidates, because absence from a partial list proves nothing. A *new* suggestion disappears once the model is
priced or the provider stops listing it. A dismissed row is never deleted for being absent, so a
dismissal survives the model leaving a listing and coming back. While it is absent the API does not
serve it: a dismissed row last seen before its provider's last complete listing describes a model
that listing did not show, so it is hidden (a `RETIREMENT_CANDIDATE` the provider lists again is
hidden the same way) and reappears, still dismissed, when the model is next seen. The rows stay
stored for as long as the provider's credential exists. A row that changes type (new to possibly
retired) starts undismissed.

Saving a credential trims surrounding whitespace from the key and `apiBase` (a pasted trailing
newline is harmless), then refuses a key still containing whitespace or control characters and an
`apiBase` containing a username or password, each with a `400` (`INVALID_CREDENTIAL`). A dismissal, an
undismissal and an on-demand run are each written to the config audit log (`ModelSuggestion`).

**The workflow editor's cost estimate** prices each step from the same source. A step's
`costHint` names a role; `GET /model-catalog/role-pricing` — readable by any signed-in user, since
template authors cannot read the agent library — returns, per role, the model its GLOBAL agent runs
(following `inheritsModelFrom`) and that model's catalog price, else its built-in one. A role whose
model nothing prices keeps the estimator's default, which tracks the seeded agents' built-in prices
(`costEstimator.test.ts` fails when they drift apart).

**Setting a price** — for a negotiated rate, a self-hosted model (`0`/`0`), or a model the built-in
table lacks — is a Catalog tab edit, or a call to the catalog API under
`/api/v1/platform/model-catalog` (recipes in [Scripted operations](#scripted-operations)). Any signed-in user can read the catalog; every write
is ADMIN-only, because a price decides what USD budgets see, and is recorded in the config audit log
as a `ModelCatalogEntry`.

| Route | Effect |
|---|---|
| `GET /model-catalog` | Lists the catalog. `?kind=CHAT\|EMBEDDING`; RETIRED rows only with `?includeRetired=true`. A built-in row carries `builtin`, the values code ships, so a customized row shows what it diverges from |
| `POST /model-catalog` | Adds a model. A spec already in the catalog is a `409` |
| `PUT /model-catalog/:id` | Edits prices, `kind`, `status`, `displayName` or `notes` — never `provider` or `modelId`. An edit to a built-in row marks it customized, so startup seeding keeps it |
| `POST /model-catalog/:id/reset` | Restores a built-in row to the values code ships and clears customized |
| `DELETE /model-catalog/:id` | Removes a custom row. A built-in row is a `409` — startup would re-create it; set it RETIRED |
| `GET /model-catalog/unpriced` | Specs in use that nothing prices, each with where it is used and the spec it most likely meant |
| `GET /model-catalog/suggestions` | ADMIN. The stored suggestions (`type` `NEW` or `RETIREMENT_CANDIDATE`) and, per provider, when it was last checked and its last error. Dismissed ones only with `?includeDismissed=true`, with `hiddenDismissed` counting those hidden, per type (`NEW`, `RETIREMENT_CANDIDATE`). A `NEW` one the catalog now prices, and a `RETIREMENT_CANDIDATE` whose model is now retired or gone from the catalog, are omitted |
| `POST /model-catalog/suggestions/:id/dismiss`, `…/undismiss` | ADMIN. Hides or restores one suggestion. Dismissal is kept across runs |
| `POST /model-catalog/discover` | ADMIN. Runs a discovery pass now and returns, per provider, the unpriced models it lists, the priced ones it no longer lists, or why it could not be listed. Writes no catalog row, but refreshes the stored suggestions exactly as the scheduled run does |

**Unpriced models are reported on save, and refused at run time only under a USD cap.** Saving an agent version or the embedding config
returns `catalogWarnings` beside `scanWarnings` when its model is not priced (with a did-you-mean
such as `gpt-5-5` → `gpt-5.5`), is DEPRECATED or RETIRED, or is the wrong `kind`. The save still
succeeds: a model released today, a self-hosted endpoint or a pinned version must not be blocked on a
price. `/model-catalog/unpriced` collects the same gap across every active agent, the embedding
config, and the models recorded LLM calls used in the last 30 days.

At run time a model with no price is refused only where a USD-denominated cap would otherwise stop
counting: an organization with a monthly budget and a channel with a monthly budget. The
organization's cap covers every run billed to that organization by the rule billing and the mid-run
cap guard use (the work request's connection, else the run's own, else the ledger row's repository):
the implementer and its fix sessions, the review network, planner, decomposers, security gate,
memory passes, and generic `agent` nodes, including a PRD run and a code-route channel task, which
bill through a connection. It also covers every runless workflow whose spend owner is the
organization (lesson consolidation, and workflow authoring and explaining through `runAgent`),
since runless spend counts toward the cap through the owner stamped on its trace rows. A run no
connection or repository places in an organization is outside that cap, so only a channel budget
refuses it. The
refusal is a non-retryable `MODEL_UNPRICED` naming the model; while the catalog cannot be read it is
a retryable `MODEL_PRICE_UNAVAILABLE`. Without such a cap the call proceeds at $0.

`MODEL_PRICE_<PROVIDER>_<MODEL>` environment overrides are not read. The worker names any that are
set at startup.

### Keeping the built-in catalog current

The `model-catalog-refresh` template is a built-in workflow, installed on every deployment, that
updates the **source** of the catalog: the `BUILTIN_MODELS` table in
`packages/shared/src/lib/builtinModels.ts`. It runs only when someone launches it or puts it on a
schedule, against a repository that holds that file — normally your fork of auto-swe. Its output is a
**draft pull request**. Once a deployment runs a build that contains the merged change, its next
gateway restart carries the new rows to `syncModelCatalog`, which applies them only to built-in rows
an admin has not customized.

The run, in order:

1. **Check the repository.** The `listProviderModels` step reads the catalog file through the SCM
   file API. The path is fixed: it is one constant (`BUILTIN_MODELS_PATH`), used by the step, the
   changed-files guard and the test gate, and it is not configurable. Before any workspace exists the
   step fails, non-retryably, if the file is missing or has no `export const BUILTIN_MODELS`, so a
   repository that is not a fork of auto-swe costs nothing.
2. **Stop if the last refresh is still open.** A schedule gives every firing the same ticket id,
   and so the same branch (`<branch prefix>/<ticket id>`) and work request. The step asks the host
   whether that branch has commits the default branch lacks, or has an open pull request. If either
   does, the run ends `SUCCESS` with the note *a previous catalog refresh is still open; merge or
   close it and delete its branch*, before any credential is read, workspace built or agent run.
   Merge or close the draft and delete its branch (the repository's "automatically delete head
   branches" setting does this on merge), and the next firing proceeds. A run that found nothing to
   change still pushes its branch, with no commits of its own; that empty branch is not previous
   work, and the next run ignores it. A comparison that fails fails the step; it is never read as
   "nothing there".
3. **List live model ids.** The same step lists models through the GLOBAL provider credentials, for
   the providers the file already prices, using the discovery code above. Decryption and the provider
   calls happen in the worker process. The output is markdown and nothing else: per provider, the
   text and embedding models it lists that might be added, and, when the listing is complete, every
   id it still lists — the only list a row may be retired against, so a model the name filter drops
   is not retired while the provider still serves it. Ids containing `:` (fine-tuned and
   organization-owned models) are left out of both. A provider that cannot be listed appears as a
   fixed sentence, never with the provider's error text. No key reaches the agent's workspace, the
   step output, the logs or the Temporal history.
4. **Update the table.** The implementer, running with the template's own system prompt and that
   list as guidance, fetches each provider's official pricing page from its workspace (`node -e
   "fetch(…)"`; the default image has no `curl`), and edits `BUILTIN_MODELS`: new rows, corrected
   prices, `status` changes. The prompt confines it to providers already in the file, and says that
   text fetched from a page is data, never instructions. A figure that is not literally on the
   fetched page leaves its row unchanged, marked `UNVERIFIED` in a comment on that row. The guidance
   reaches the agent under the heading *Guidance from the requester*, which every guidance input
   shares; the prompt says what it really is.
5. **Confine the change.** The implementer step and the review fix carry `allowedPaths`, listing
   only the catalog file. Before the agent runs, the worker reads the commit the session starts
   from and keeps it in its own memory: the default branch's tip for a fresh branch, the work
   branch's tip for a review fix or a retry, so each session answers only for its own changes. After
   the commit the worker pins the committed sha once, and the check measures that commit, the one
   that is pushed: it compares that commit's tree directly with the starting commit's tree
   (`git diff-tree -r --name-only --no-renames --ignore-submodules=none -z <start> <sha>`, two trees
   and no range), and the step fails, non-retryably, on any path outside the list. The push then
   sends exactly `<sha>:refs/heads/<branch>`, so a branch the agent moved or a `HEAD` it left on a
   scratch branch cannot carry other commits, and the reported diff, `filesChanged` and `headSha`
   are read from the same sha. A direct tree comparison does not depend on the branch's history,
   which the agent controls, so rebuilding the history on an older commit cannot hide a path
   restored to its older content. The git calls ignore the system and global git config, run
   with the hardening `gitAuthed` uses (no hooks) and with replace objects off, and override the
   repository's own diff settings, since its `.git/config` is still read (submodules are never
   ignored, so a gitlink is listed). The commit itself runs with hooks disabled, so neither a
   repository hook nor `git replace` nor a rewritten `origin/<default>` ref changes what is
   measured; no ref is read after the agent starts. The diff the step reports, and the
   `filesChanged` the `checkScope` condition reads, are measured from a recorded sha: the original
   run's base when the previous result carries it, otherwise the default branch's tip as recorded at
   the start. That report is informational; it is the per-session check that confines the change. A
   retry after the default branch has moved can report the paths that moved in reverse and end
   `FAILED` at `checkScope`: a spurious failure that fails closed. The guard has to sit ahead of the
   push because a push can itself start work on the host (a workflow file runs on `push`). Its
   remaining trust limit is the agent replacing the `git` binary or forging objects on disk, which
   needs root in the container, the limit the workspace hardening already documents. A `checkScope`
   condition before the pull request asserts the same thing about the cumulative change, and a miss
   fails the run. `allowedPaths` is an optional config field on both steps; unset, nothing changes
   and the original commands run.
6. **Check and open.** If the diff is empty the run ends `SUCCESS` with no pull request. Otherwise
   the `runTests` gate runs `builtinModels.test.ts`, the review network judges the change against the
   success criterion *every changed price cites an official URL; no invented figures*, the review
   fix follows the same rules as the first pass, and the run opens a **draft** pull request and ends.
   There is no CI loop and no approval inside the run.

**The `runTests` gate is advisory.** The gate runs in warn mode: a failing `builtinModels.test.ts`,
or an install that fails, is recorded and the run goes on to review and a draft pull request. CI on
that draft is the hard check, and it also runs the file's own test.

**Every price carries its source.** Each `BUILTIN_MODELS` row has a required `priceSourceUrl`, the
provider's official pricing page, and `builtinModels.test.ts` fails on a row without an `https` URL
on its provider's pricing host. The allowed host per provider is fixed in the test, and the test
also requires the file's header to cite exactly those pages, so neither a row nor the header can
widen the allowlist in the same diff; adding a provider is a deliberate edit to the test, which the
changed-files guard keeps out of the agent's diff. It is a page per provider, not a per-model
anchor.

**A draft is never replaced by a ready pull request, nor added to once it is ready.** The pull
request step takes a `draft` option, which this template sets. When the host refuses a draft, the
step fails with `DRAFT_PR_UNSUPPORTED` and opens nothing. When a pull request for the work request
or the branch is already open and is not a draft — a person has marked it ready for review — the
step fails with `EXISTING_PR_NOT_DRAFT` instead of reusing it, so agent commits are never added to
a reviewed pull request. The check reads the draft state from the host's pull request list on one
path and costs one API call on the other, and only when a draft was asked for. Other templates do
not set `draft` and are unchanged, including their reuse of an open pull request on a retry.

**Pointing it at a fork and scheduling it.** Register your fork as a repository, then create a
schedule against it with `templateId` set to this template, for example:

```bash
curl -X POST "$GATEWAY/api/v1/scheduled-work-requests" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Model catalog refresh","repoId":"<fork-connection-uuid>",
       "templateId":"<model-catalog-refresh template uuid>",
       "cronExpression":"0 6 * * 1","externalTicketPrefix":"CATALOG",
       "description":"Refresh the built-in model catalog from the providers."}'
```

or launch it once from the dashboard with the same repository. A schedule acts as its author, so
that user needs write access to the fork. Set the fork's test command on its connection to something
quick: the implementer runs it after each turn.

### Setup readiness

`GET /api/v1/platform/readiness` (ADMIN) reports whether a first run has what it needs: every provider
used by an active GLOBAL agent's own model, and by the embedding model, has a GLOBAL credential (an
agent pinned to its own credential does not need one); GitHub has a token or an App, from the database
or the environment; and at least one repository connection exists. Home shows the missing items to
admins with a link to each fix, the Credentials tab marks each needed provider present or missing, and
the Models, Integrations and Connections pages show a banner for the items they can fix. A sub-role
that inherits its model is covered by the agent it inherits from.

### Bootstrap (fresh deployment)

1. `yarn db:migrate && yarn db:generate && yarn db:seed` — schema + admin user.
2. Start gateway + web only (not the worker yet).
3. The DB seed already created the built-in `Agent` rows — 17 model-backed with default model specs, plus 12 sub-role personas that inherit a parent's model — along with the `EmbeddingConfig` singleton. Sign in as admin and add a `ProviderCredential` at `/studio/models` → Credentials.
4. Add at least one `ProviderCredential` on the Credentials tab. For the seeded defaults you need at minimum `anthropic` (for the agent roles) and `openai` (for embeddings).
5. Start the worker. `assertConfigReady()` walks the DB; missing pieces are listed in a single rolled-up error pointing back to the dashboard.

Per-role baked-in defaults seeded onto the GLOBAL Agents (also recorded in `AGENTS.md`):

| Role / Slot | Default |
| ----------- | ------- |
| `implementer` / `reviewer` / `commitToMemory` / `channelAssistant` / `workflowAuthor` | `anthropic/claude-opus-5-5` |
| `planner` / `securityReview` / `validateContext` / `workflowExplainer` | `anthropic/claude-sonnet-5-5` |
| `evalJudge` | `anthropic/claude-haiku-4-5-20251001` (distinct model to avoid self-preference bias) |
| Embeddings | `openai/text-embedding-3-large` |

The 12 sub-role personas carry no `modelSpec` — each binds its parent's model via
`inheritsModelFrom`. `contentWriter`, `brandReviewer`, `supportResponder`, `productAnalyst`,
`prdWriter`, and `issueDrafter` are model-backed agents added for the non-SWE workflow packs. Full roster in [`agents.md` §1](./agents.md#1-agents).

When a seeded default changes, the startup sync moves an existing deployment forward only where
nobody chose otherwise. A built-in GLOBAL Agent whose latest version still carries the default it
was seeded with (`PREVIOUS_DEFAULT_MODEL_SPECS` in `shared/src/lib/syncBuiltins.ts`) gets a new
version on the current default, copying every other field and its skill refs — the same new-version
cut the Agent library makes for an admin's edit. The old version is never rewritten, so a run
already pinned to it keeps the model it started with; new runs pick up the new version. Any other
value — a different model, a scoped override, a deactivated lineage — is left alone.

---

## Day-2 operations

### Adding a new provider

Pick a name (`opencodego`, `groq`, `bedrock`, …). If the provider speaks the OpenAI Chat Completions API, it's plug-and-play:

1. Sign into the dashboard as an admin → **Admin → Model Config → Credentials → + New credential**.
2. Provider name: lowercase kebab-case, e.g. `opencodego`.
3. Scope: GLOBAL (visible everywhere) or TEAM.
4. API base: e.g. `https://opencode.ai/zen/go/v1`.
5. API key: paste from your password manager — you won't see it again after save.
6. Click **Test** to verify the credential works (issues a `GET <base>/models` probe).

A built-in provider (`anthropic`, `openai`, `google`) with an API base set — a proxy or gateway in front of the vendor — is probed and discovered at `<base>/models` with that provider's own auth style, behind the same SSRF guard. With no API base, the vendor's endpoint is used.

Agents name the provider by that same lowercase name in their model spec: `opencodego/glm-5.2`, `openrouter/openai/gpt-6-luna`. Specs are stored with the provider lowercased and the model id as written, and a spec without a provider is refused on save. Saving an agent whose provider has no credential reachable from its scope — or whose reachable credentials for a non-built-in provider all lack an API base — succeeds but returns `credentialWarnings`.

Structured output differs by client. The built-in providers enforce a response schema natively. An OpenAI-compatible endpoint is sent JSON mode (`response_format: json_object`) with the schema written into the system prompt, so a reviewer verdict, a plan or a lesson comes back in the shape its caller validates on any endpoint that supports JSON mode — but conformance rests on the model following the prompt, not on the endpoint enforcing a schema.

A built-in `openai` credential with an API base is called through Chat Completions, which most proxies and gateways serve; without one, OpenAI's Responses API is used.

If the provider speaks a different API (e.g. Anthropic-style `/v1/messages`), you need a code change in `packages/worker/src/lib/models.ts` `buildModelUncached()` to construct the right SDK client. The current built-ins are `anthropic`, `openai`, `google`; everything else routes through `@ai-sdk/openai-compatible`.

### Overriding a model for one team

1. **Teams → \<team-slug\> → Team overrides**.
2. Pick the role row → **Override** → enter a model spec (e.g. `openai/gpt-6.1-sol`).
3. Optionally pin a specific credential (the picker shows GLOBAL + this team's TEAM-scope creds). The API refuses a pin with `400 INVALID_CREDENTIAL` when the credential does not exist, is for a different provider than the model spec, or belongs to another team or to an organization the team is not in.

Removes via the **Reset** button. Resetting causes the next activity call for that role to fall back to GLOBAL.

### Overriding a model for one workflow template

Admin-only, from the Agent library at `/studio/agents/library`. Create an Agent for the key with scope `WORKFLOW_TEMPLATE` and supply the template ID. The template editor itself carries no model section — template-scoped overrides are edited in the Agent library.

### Rotating an API key

1. **Admin → Model Config → Credentials → Edit \<provider\>**.
2. Paste the new key (the API key field is blank-by-default; an empty submission keeps the existing key).
3. Save. The worker's cache picks up the new key within 30 seconds (or immediately if `CONFIG_CACHE_TTL_MS` is lower); workflows mid-run will use the new key on their next LLM call.

This rotates the *provider's* key, not the master key auto-swe encrypts it with. For that, see below.

### Rotating `CONFIG_ENCRYPTION_KEY`

The master key wrapping every stored secret. `decryptSecret` picks its key by the row's
`key_version`, so old and new can coexist for the length of a rotation:

```bash
# 1. New key
openssl rand -base64 32

# 2. Set on BOTH gateway and worker, then restart both
CONFIG_ENCRYPTION_KEY=<new>
CONFIG_ENCRYPTION_KEY_VERSION=<old version + 1>    # default is 1
CONFIG_ENCRYPTION_KEY_PREVIOUS=<old>

# 3. Check, then rotate
yarn keys:rotate --dry-run
yarn keys:rotate

# 4. Once it reports nothing left, drop CONFIG_ENCRYPTION_KEY_PREVIOUS and restart
```

`yarn keys:rotate` runs through `tsx`, a devDependency, so it works from a checkout but not
inside a production image (`yarn workspaces focus --production` strips it). There, run the
compiled entry point directly:

```bash
node packages/shared/dist/scripts/rotateEncryptionKey.js --dry-run
node packages/shared/dist/scripts/rotateEncryptionKey.js
```

Step 2 is what makes this safe against a live deployment: rows written under the old key still
decrypt, while new writes are stamped with the new version. The rotation is resumable — a row
already at the target version is skipped — and it never writes a row it could not read, so an
interrupted run leaves a mix of versions that a re-run finishes.

`CONFIG_ENCRYPTION_KEY_PREVIOUS` holds exactly one older key, the version immediately below the
current one. That is the only state a rotation passes through; a general version→key map would let
arbitrarily many retired keys linger, which is the opposite of the point.

**Do not drop the previous key while `yarn keys:rotate` still reports failures.** It exits non-zero
and names each row it could not decrypt; those rows are left untouched and are unrecoverable if the
key that wrote them is gone.

### Auditing changes

**Admin → Model Config → Audit log** shows the last 100 mutations across agent configs and credentials. Secret material is redacted (only `lastFour` survives in `beforeJson`/`afterJson`). Use this when investigating cost spikes or unexpected behavior changes. The data comes from `GET /api/v1/platform/config/audit-log`; the older `GET /api/v1/platform/config-audit-log` endpoint no longer exists.

---

## Env vars

The only LLM-related env var is `CONFIG_ENCRYPTION_KEY` — required for the gateway and worker to start. It's a base64-encoded 32-byte AES-256-GCM master key used to encrypt/decrypt `provider_credentials.api_key_ciphertext`. Generate one with `openssl rand -base64 32` or `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.

`CONFIG_CACHE_TTL_MS` (optional, default 30000) tunes the resolver cache.

There are no env vars for model selection, provider API keys, or embedding settings — all of those live in the DB. If you're upgrading from a previous version that read `*_MODEL` / `ANTHROPIC_API_KEY` / etc., nothing is migrated automatically: the DB seed creates the model-backed `Agent` rows (with default specs) + the `EmbeddingConfig` singleton (historical `openai/text-embedding-3-large` default); re-enter provider credentials in the dashboard.

---

## Scripted operations

Everything in the dashboard maps 1:1 to gateway endpoints. A few common recipes:

Per-agent model, prompt, skills, and tools all live on the `Agent` entity, so they are written
through the **agent-library** API — there is no separate model-config write endpoint. Agent keys are
free-form strings (`implementer`, not `IMPLEMENTER`), and every write cuts a new immutable version.

```bash
TOKEN=<admin-PAT>

# Override one agent's model for one team. Scope discriminators are exclusive:
# TEAM scope takes teamId and nothing else.
curl -X POST http://localhost:8080/api/v1/platform/agent-library \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "key": "implementer",
    "name": "Implementer (payments override)",
    "scope": "TEAM",
    "teamId": "<team-uuid>",
    "modelSpec": "anthropic/claude-opus-5-5"
  }'

# Rotate a credential (admin scope). Provider + scope are immutable; only
# apiBase and apiKey can change.
curl -X PUT http://localhost:8080/api/v1/platform/credentials/<credential-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"apiKey": "sk-ant-new..."}'

# Probe a credential (issues a list-models HTTP call).
curl -X POST http://localhost:8080/api/v1/platform/credentials/<credential-id>/test \
  -H "Authorization: Bearer $TOKEN"

# Price a self-hosted model as free.
curl -X POST http://localhost:8080/api/v1/platform/model-catalog \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"provider": "ollama", "modelId": "llama-4", "inputUsdPerMTok": 0, "outputUsdPerMTok": 0}'

# Apply a negotiated rate to a built-in model (marks it customized), then undo it.
curl -X PUT http://localhost:8080/api/v1/platform/model-catalog/<entry-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"inputUsdPerMTok": 3.5, "outputUsdPerMTok": 17}'
curl -X POST http://localhost:8080/api/v1/platform/model-catalog/<entry-id>/reset \
  -H "Authorization: Bearer $TOKEN"

# Which models in use have no price?
curl http://localhost:8080/api/v1/platform/model-catalog/unpriced \
  -H "Authorization: Bearer $TOKEN"

# What did the last discovery run find, and when was each provider checked?
curl http://localhost:8080/api/v1/platform/model-catalog/suggestions \
  -H "Authorization: Bearer $TOKEN"

# Ask the providers now (also refreshes the stored suggestions)
curl -X POST http://localhost:8080/api/v1/platform/model-catalog/discover \
  -H "Authorization: Bearer $TOKEN"
```

Team owners use the parallel team-scoped routes — `/api/v1/teams/<teamId>/agent-library` for agent
overrides and `/api/v1/teams/<teamId>/credentials` for credentials. Same shapes; scope is forced
server-side. Full endpoint table in [`agents.md` §9](./agents.md#9-skill--agent-library-api).

### What happens when you delete a pinned credential

`Agent.credentialId` is `ON DELETE SET NULL`. Deleting a credential row leaves any rows that pinned it pointing at NULL, so the resolver falls back to the standard provider-name credential cascade on the next call. No data loss; just a silent demotion. The audit log captures the credential's removal but not the implicit fallback. A pin that is set but unusable — another provider after a model change, or a team credential resolved for another team's run — falls back the same way, with a worker warning.

---

## Wire-level details

| Layer | File | Notes |
| ----- | ---- | ----- |
| Prisma schema | `packages/shared/src/prisma/schema.prisma` | `Agent`, `ProviderCredential`, `ConfigAuditLog`, enums |
| Crypto | `packages/shared/src/lib/crypto.ts` | AES-256-GCM helpers |
| Resolver | `packages/worker/src/lib/config/agentResolver.ts`, `packages/worker/src/lib/config/resolver.ts` | `resolveAgent` (Agent overlay) + cascade + cache + ConfigMissingError |
| Context lookup | `packages/worker/src/lib/config/contextLookup.ts` | currentWorkflowId → teamId/templateId |
| Startup check | `packages/worker/src/lib/config/assertReady.ts` | Walks every required row at worker boot |
| Worker integration | `packages/worker/src/lib/models.ts` | Async `getModel` / `getModelSpec` (per-role chat models) |
| Embeddings | `packages/worker/src/lib/embeddings.ts` | Reads the singleton `EmbeddingConfig` via `resolveEmbeddingConfig` |
| Gateway routes | `packages/gateway/src/routes/modelConfig.ts` | Admin + team-scoped credential CRUD, embedding-config CRUD, credential probe |
| Gateway routes | `packages/gateway/src/routes/modelCatalog.ts` + `lib/modelCatalogService.ts` | Model catalog CRUD and reset, the unpriced report, and the `catalogWarnings` agent and embedding saves return |
| Dashboard | `packages/web/src/app/studio/models/page.tsx`, `packages/web/src/components/modelConfig/*` | Tabbed admin UI (Roles / Credentials / Embeddings / Audit log) + team detail integration |

---

## Troubleshooting

**Worker exits at boot with `"LLM configuration incomplete"`**: the `assertConfigReady()` startup check found missing GLOBAL rows. The full error lists everything missing. Bring up the gateway + web, sign in as admin, add the required `ProviderCredential` rows (the agents themselves are seeded), then restart the worker.

**`"Provider '<name>' is not built-in and requires an apiBase on its credential"`** (thrown from `buildModelUncached`, or with the `Embedding provider` prefix from `buildEmbeddingModel`): the credential resolved for a non-built-in provider has no `apiBase`. Set the `apiBase` from the dashboard.

**Worker logs `agent credential pin not usable`**: an agent's pinned credential was deleted, is for a different provider than its model spec (`reason: provider-mismatch`, typically after the model was changed), or sits at a team or organization the run does not belong to (`out-of-scope`). The call proceeds on the provider-name cascade. Re-pin a matching credential or clear the pin.

**Test button returns `"apiBase rejected: host '…' is on a private network"`, or discovery and Test report `blocked address`**: the gateway's SSRF guard blocks loopback / RFC1918 / link-local / `.local` / `.internal` hosts, and refuses a name that resolves to one. For an internal provider (vLLM, Ollama, an internal gateway), an ADMIN lists its host in `models.privateNetworkHosts` at `/govern/platform-settings` (`internal.example.com`, or `10.0.0.5:8000` when it has a port), then saves or tests the credential again; the change applies within the settings cache's ~30 s. Loopback, `localhost` and link-local / cloud-metadata addresses stay refused whatever is listed, so a service on the gateway's own host needs a routable name (`host.docker.internal`, a Compose service name). `blocked address` also appears when the gateway container cannot resolve the name at all.

**Model changes don't seem to apply mid-run**: confirm the activity is past the `await getModel(...)` call before you edited. Already-bound `LanguageModel` instances aren't swapped mid-`generate()`; the next call after the cache TTL (default 30s) picks up the new value.

---

## Limitations

- **The config cache means edits are eventually consistent.** Model config is cached in-process with
  a ~30 s TTL (`CONFIG_CACHE_TTL_MS`) and gateway and worker are separate processes, so the two can
  briefly disagree after an edit. A `generate()` call already in flight keeps the model it bound.
- **Pricing is keyed on the resolved `provider/model` spec.** A model with no catalog row and no
  `BUILTIN_MODELS` entry records usage at **zero cost** — the span carries
  `llm.cost_pricing_known=false` — wherever no USD cap applies. Per-run budget tiers are enforced on
  tokens, so an unpriced model is still capped there. Where an organization or channel monthly
  budget applies, the call is refused instead (see above). Embedding calls and the eval harness are
  not covered by that refusal, and a cost shown for a run on an unpriced model is $0.
- **The editor's cost estimate prices GLOBAL defaults.** It uses the model each role's GLOBAL agent
  runs, so a team, organization or template override of that agent's model is not reflected, and
  token counts come from each step's static `costHint`, not from measured runs.
- **Discovery finds ids, not prices.** It reads no price from a listing, even where one carries
  prices (OpenRouter's does), so an admin still enters every number that feeds USD budgets. It reaches only models listed through a GLOBAL
  credential; one reachable only through a team or organization credential is not found. It suggests
  by name, not by capability: speech, transcription, image, video and moderation models are dropped
  by a name filter that can miss one or drop one it should not, and outside Google — which says which
  methods a model serves — whether a model is chat or embedding is read from its id. Up to five
  pages per provider are followed.
- **A private `apiBase` needs an admin opt-in, and a loopback one is never allowed.** Saving a
  credential, its **Test** button, discovery and the scheduled catalog refresh all refuse a host that is
  or resolves to a private address, reported as `blocked address`, unless `models.privateNetworkHosts`
  lists it. The list is platform-wide (GLOBAL, ADMIN only), not per credential, so every team that
  names a listed host reaches it. Listing a name trusts DNS to mean the server intended, and the
  scheduled run makes these calls from the worker. Loopback, `localhost`, link-local and cloud-metadata
  addresses stay refused. Inference and embedding calls do not pass through this guard.
- **Retirement flags reflect what one key can see.** A key restricted to some models (an OpenAI
  project key, say) flags every other priced model of that provider as possibly retired.
- **A retirement flag is a hint.** A provider may serve an alias or a pinned id it does not list, so
  a priced model can be flagged while it still works, and a model a provider stops serving but keeps
  listing is not flagged. The flag is cleared when the provider lists the model again or an admin
  retires it.
- **The catalog refresh reads human-oriented pages.** Pricing pages are written for people, not
  programs, so the agent's extraction can be wrong: a figure can be attached to the wrong model, a
  row for a model a page lists only in a table it cannot parse can be missed, and a page that
  renders its prices with JavaScript yields none. The `UNVERIFIED` rule, the cited `priceSourceUrl`,
  the review network and the pinned host allowlist narrow that, and `builtinModels.test.ts` proves a
  citation exists on the right host, not that the figure beside it is right. The draft pull request
  and its cited sources are the control: a person checks each changed price against the page before
  merging.
- **The refresh treats the pages as untrusted, and contains the damage rather than preventing the
  attempt.** The agent has network access and a shell. The diff guard keeps its edits to the catalog
  file and the prompt tells it to treat fetched text as data, but a hostile page can still make it
  write a wrong price inside that file, which is what the review and the cited sources are for.
- **The refresh reaches only providers the file already has, and only the ids listed.** The listing
  is filtered to those providers in code; the restriction on *prices* to those providers is the
  prompt's, and the review's, not a check. It adds no provider, and it sees only models listed
  through a GLOBAL credential, with the same name filter and page cap as discovery. A provider whose
  listing fails keeps its ids as they are. Ids containing `:` are left out, but a provider-owned
  check beyond that (such as OpenAI's `owned_by`) is not made, so another organization-visible id
  without a colon would still be listed. Anyone who can launch the template against a repository
  holding the catalog file gives the agent that listing, which is otherwise an admin-only view.
- **`UNVERIFIED` is a comment on the row.** The pull request body is generated from fixed text and
  carries none of the agent's own notes. A run whose only change is `UNVERIFIED` comments still
  opens a draft each time the previous one is closed, because those comments are not merged and are
  added again by the next run. An empty diff still leaves its work branch pushed, with no pull
  request; the next run ignores that empty branch. A run that stops because the previous refresh is
  still open ends `SUCCESS` with a note, so a stuck schedule looks green in the run list.
- **The schedule is read at gateway startup.** Changing `MODEL_DISCOVERY_ENABLED` or
  `MODEL_DISCOVERY_CRON` needs a gateway restart to take effect.
- **The model pickers suggest; they do not restrict.** A spec the catalog lacks can be typed and
  saved, and is recorded at $0 until it is added — the save's `catalogWarnings` and the unpriced
  panel say so, but nothing blocks it.
- **Unpriced-model detection is exact-match plus a heuristic.** The did-you-mean only proposes a
  priced spec that differs by `.`/`-` or case, or the single nearest spec from the same provider
  within two edits; a model it cannot match is reported with no suggestion.
- **Prices are base rates apart from prompt caching.** Data-residency and fast-mode premiums and
  long-context surcharges are not modelled, so a call that used them is recorded at the base rate.
- **Only the models the code table names carry a cache discount by default.** A cached read on any
  other model is recorded at the full input price, which overstates it, until an admin sets the
  row's multipliers in the Catalog tab.
- **The 1-hour write rate needs the provider's TTL breakdown.** It applies only where the usage
  object carries `cacheCreationInputTokens1h` (the Mastra path with an Anthropic response that
  reports `cache_creation`); a call without it prices every write at the 5-minute rate, which
  understates a 1-hour write by the difference.
- **No batch pricing.** Nothing calls a provider's batch API, so the batch discount never applies.
- **Credential resolution has no fallback past GLOBAL.** The TEAM → ORGANIZATION → GLOBAL cascade
  ends there; a missing GLOBAL row is a `ConfigMissingError`, not a silent skip.
- **Embedding providers are OpenAI, Google and OpenAI-compatible endpoints.** Anthropic has no
  embedding model and is refused at save and at worker boot. OpenAI and Google models are asked to
  truncate to 1536 dimensions; an OpenAI-compatible endpoint is sent `dimensions: 1536`, and one that
  answers 400 to it is retried without the field, so its model must then be natively 1536-wide.
- **Structured output from an OpenAI-compatible endpoint is prompt-guided.** The schema reaches the
  model in its system prompt, not as an enforced `json_schema` response format, so a model that
  ignores instructions can still return JSON its caller rejects, and an endpoint that refuses
  `response_format: json_object` fails those calls outright.
- **Credential coverage is advised, not enforced.** `credentialWarnings` on an agent save, and the
  setup readiness check, both look only at whether a credential exists where the agent could reach
  it. Neither tests the key, and readiness covers GLOBAL agents only.
- **Embeddings are locked to 1536 dimensions.** `memory_items.embedding` is `vector(1536)`, so a
  model returning any other shape throws. Changing dimension is a migration plus a re-embed of every
  `MemoryItem`; the bulk re-embed below handles the second half, but nothing performs the migration.
- **Changing the embedding model hides memory until it is re-embedded.** Recall and consolidation
  compare vectors from one model only, so rows embedded by the previous model drop out of both.
  Nothing re-embeds them on save: the Embeddings tab reports how many there are and starts
  `ReembedStaleMemoryWorkflow` on request (one embedding call per row), because the cost is the
  admin's to accept ([memory.md §6](./memory.md#6-administration)).
- **The boot check reflects install state at boot.** `assertConfigReady` gates on the agents the
  installed templates can reach. Activating a template afterwards is not re-checked, so a newly
  reachable agent with no credential fails at its node instead of at startup. Restart the worker to
  restore fail-fast.
