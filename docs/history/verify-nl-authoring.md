# Verifying NL workflow authoring (live)

> **Frozen.** Point-in-time document, preserved for design rationale. It is not maintained: the code and the current references in [`docs/`](../README.md) are authoritative wherever they diverge.

This is the manual runbook for exercising the natural-language workflow features
end-to-end against real infrastructure. It complements the automated coverage:

- **Unit tests** — the catalog renderer, the generate→validate→repair loop, the
  explain activity, the persist activity, and the gateway routes.
- **Integration test** — `packages/worker/src/activities/generateWorkflowSpec.integration.test.ts`
  generates a spec through the real loop and then **executes it through the real
  interpreter (`runSpec`)**, proving a generated graph is not just schema-valid
  but actually runnable (this is what caught the `cond` expression-language
  mismatch). Run it with:

  ```bash
  yarn vitest run packages/worker/src/activities/generateWorkflowSpec.integration.test.ts
  ```

The steps below need Postgres + Temporal, so they can't run in a sandbox without
a Docker daemon — run them locally or in a full environment.

## 1. Bring up infra + seed

```bash
cp .env.example .env   # set CONFIG_ENCRYPTION_KEY, SEED_ADMIN_PASSWORD
yarn docker:infra:up
yarn db:migrate && yarn db:generate && yarn db:seed
```

The seed creates the GLOBAL `workflowAuthor` (opus) and `workflowExplainer`
(sonnet) agents via `syncBuiltins`. Add an Anthropic `ProviderCredential` at
`/admin/model-config → Credentials` (the seeded specs are Anthropic).

```bash
yarn dev:gateway   # :8080
yarn dev:web       # :3000
yarn dev:worker
```

## 2. Generate (CLI, synchronous)

```bash
TOKEN=<paste a PAT from Settings → API tokens>
auto-swe workflows generate "When a ticket comes in, validate context, run the \
  implementer, run the review network, and open a pull request" --team <slug>
# → Created DRAFT "<name>" (id …)  + a one-line summary
auto-swe workflows show "<name>"   # inspect the generated spec JSON
```

## 3. Generate (web, async + progress)

- Web → **Workflow library** → **Generate with AI** → describe → **Generate draft →**.
- Watch the live phase change (Designing… → Saving…) — the request is
  non-blocking (`POST /generate/jobs` → poll `GET /generate/jobs/:jobId`).
- On success you land on the canvas for the new DRAFT. Review, then **Activate**.

## 4. Explain

- On the template detail page click **Explain** for a plain-language walkthrough,
  or:

  ```bash
  auto-swe workflows explain "<name>"
  ```

## 5. Run the generated workflow

- Activate the DRAFT (promote / set status ACTIVE), then **Run →** with inputs.
- Confirm in `/runs/<id>` that the nodes execute in the expected order and the
  run reaches SUCCESS. This is the ultimate check that a generated spec is valid
  *and* executable.

## 6. Slack (optional)

- In a configured channel, `@mention` the assistant: "create a workflow that runs
  the implementer then opens a PR". It replies with the draft name + a pointer to
  the Workflow library. Confirm a DRAFT template was created for the channel's team.

## Checklist

- [ ] `workflows generate` creates a DRAFT (CLI, sync)
- [ ] Web async generation shows progress and lands on the canvas
- [ ] Generated `cond` nodes use the safe expression language (`==`, not `===`)
- [ ] `workflows explain` / web Explain returns a readable summary
- [ ] The activated workflow runs to SUCCESS in `/runs`
- [ ] Channel `@mention` drafts a workflow (if Slack configured)
