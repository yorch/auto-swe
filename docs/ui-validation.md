# UI validation

UI validation combines an in-container browser executor, run evidence storage, per-repository
preview recipes, a workflow gate and an explicitly granted agent browser tool. The browser executor
image is `defaults/Dockerfile.node-browser`; it includes the pinned Playwright runtime and Chromium.
`BrowserSession` drives the in-container browser, restricts navigation to configured hosts, and can
capture screenshots, video, traces and events.

## Run evidence

Screenshots, recordings, traces and text logs use the workflow artifact store and carry run
metadata such as source, caption, page URL, workflow node, attempt and image dimensions. The run's
Evidence panel lists ready items, loads media through short-lived user-bound links and offers trace
and log downloads. Each content request reloads the link owner's active account and role and checks
current run visibility before returning bytes. Only PNG, JPEG, WebP, WebM, ZIP and plain text
content types are served as media; other content is an opaque download. The content route returns
the whole object and does not implement range requests, so a recording downloads in full before it
can seek.

An item is kept only when the recording succeeds and the configured limits allow it: a screenshot
over `uiValidation.maxScreenshotBytes`, a video over `uiValidation.maxVideoBytes`, or an item past
`uiValidation.maxEvidencePerRun` is dropped, and the step reports it in its `notes` output rather
than failing the gate. The worker reads a finalized recording and trace back independently, so a
recording that cannot be read does not cost the trace.

The scheduled transcript-pruning workflow also removes evidence older than
`uiValidation.evidenceRetentionDays`, including the public copy a pull request published, when
`UI_EVIDENCE_PUBLIC_BUCKET` still names the bucket it was written to. Evidence cleanup failures are
logged without failing transcript pruning. Size and per-run limits use the
`uiValidation.maxScreenshotBytes`, `uiValidation.maxVideoBytes` and `uiValidation.maxEvidencePerRun`
settings. The `uiValidation.agentRecordVideo` setting controls agent browser recording.

## Workflow verification

The `uiVerify` gate step reads the repository's `previewConfig`, starts the app preview inside a
workspace made with the repository's configured executor image, and records evidence against the
current workflow run. Its `mode` is `smoke`, `e2e` or `both`; by default it runs both when an `e2e`
command is configured and smoke otherwise. `recordVideo` and `failOnConsoleErrors` default to true,
and `timeoutMs` defaults to 1,200,000. An unconfigured repository returns a successful skipped
result. A preview readiness or browser-image failure is a failed gate result, so normal `onFail`
handling applies.

Smoke checks visit each configured path, optionally wait for a selector, save a screenshot captioned
with the smoke name or path, and fail on HTTP 5xx responses, page errors, or (by default) console
errors. A browser command that reports a failure — a navigation timeout, a selector that never
appears, a crashed page while the screenshot is taken — fails that page too; the driver's answer is
not treated as an empty result. E2E commands run with `CI=1`; the worker collects up to 30 PNGs, five
WebM recordings and five `trace.zip` files under the configured results directory, one file at a
time, so an unreadable artifact costs that artifact only. The app log tail is saved as `ui.log`.
Browser sessions are closed and their video and trace evidence is saved even when a check fails.

## Browser tool for agents

Mastra, Pi and Claude Code agents can use the browser tool only when `browser` appears explicitly in
their `toolKeys`. A null tool list never grants it. It reaches the implementer path on every runtime,
and an agent run; an `agent` node in a throwaway checkout does not bind it. The toolset starts the
configured preview on its first call, defaults its navigation host allowlist to empty, and records
screenshots before returning their evidence identifiers. Snapshot, title and console text is screened
before it is returned to the agent. Session cleanup waits for a start already in flight, then saves
video and trace evidence and stops the app preview. One session serves the whole toolset, so
concurrent tool calls in a single model step share it.

## PR evidence

The default PR body includes evidence counts and a dashboard link to the run's Evidence panel when
the run has evidence. The `uiValidation.prInlineImages` setting is off by default. Public image
copies are created only when that setting is enabled and both optional environment values are set:
`UI_EVIDENCE_PUBLIC_BUCKET` and `UI_EVIDENCE_PUBLIC_BASE_URL`. The worker copies at most six
screenshots to `ui-evidence/<runId>/<evidenceId>.png` without setting an ACL. Configure the public
bucket's read policy deliberately; the dashboard evidence remains access-controlled. The retention
sweep deletes those copies with their evidence, and only while `UI_EVIDENCE_PUBLIC_BUCKET` still
names the bucket they were written to. The public bucket is S3-compatible even when artifacts live
in the filesystem store: inline PR images are the one feature that always needs an object store.

## Repository preview recipes

A `git_repo` connection can hold a `previewConfig` JSON recipe. The shared strict schema checks the
setup and start commands, local readiness and base URLs, environment variables, allowed browser
hosts, smoke paths, optional end-to-end command and results directory, and service descriptions.
Changing a recipe takes the same team shell-authoring role as changing gate commands; unchanged
recipes can be saved by other repository editors.

Configured services start as workspace sidecars before preview setup runs. Docker joins each service
to the workspace network namespace, so the app reaches it through `localhost`; Kubernetes places
services in the workspace pod. Service images must be on the team's shell image allowlist. Service
containers have bounded resources, no-new-privileges and all capabilities dropped except
`CHOWN`, `SETUID`, `SETGID`, `FOWNER` and `DAC_OVERRIDE`. A configured `readyCommand` is retried
before the app preview starts. Kubernetes keeps service environment values in the workspace's
per-pod Secret rather than the Pod manifest. Agent workspaces receive the recipe's services only
when the agent has an explicit `browser` grant.

The worker's `startAppPreview` helper runs optional setup, starts the app with configured
environment values, polls the readiness URL from inside the workspace and returns a stop function
and bounded, redacted log tail. It uses the recipe's base URL, or the readiness URL's origin when
none is supplied.

## Limitations

- Kubernetes sidecars that run as root or add the service capabilities require a namespace policy
  that permits those per-container settings (typically Pod Security `privileged` or an equivalent
  exception). The workspace container keeps its non-root, dropped-capability security context.
- Public PR images are intentionally unavailable unless both environment values and the explicit
  admin setting are enabled. The public bucket's access policy is operator-managed. Renaming the
  bucket after copies exist leaves the old copies behind: retention can only delete from the bucket
  the environment currently names.
- The preview process is stopped on a best-effort basis. `startAppPreview` records the child's pid
  and signals it as a process group; the container's `sh` has no job control without a TTY, so the
  child is usually not its own group leader and the group signal finds nothing. The preview then
  dies with the workspace rather than at `stop()`, which leaves it running for the rest of a session
  that reuses the container (the agent toolset) and loses the log tail after the stop attempt.
- A worker that dies between writing an artifact and creating its `RunEvidence` row leaves a ready
  `ui.*` artifact that no evidence row, and therefore no retention sweep, points at. The
  compensating delete covers a failed insert, not a killed process.
- Evidence bytes move through the worker: the recording is read out of the container and written to
  the artifact store in memory, so the `uiValidation.maxVideoBytes` cap bounds a single worker's
  memory use, and the step's wall-clock budget has to cover the transfer as well as the recording.
- The `browser` tool is bound to the implementer path and to agent runs, not to a generic `agent`
  node in a checkout. A node that needs to look at a page must be an implementer-family step or an
  agent run whose Agent grants `browser`.
- The browser tool's `browser_screenshot` persists the image as evidence but returns the accessible
  page snapshot and the evidence id to the model, not the pixels: an agent reads the page as text,
  and a person sees the picture on the run page.
