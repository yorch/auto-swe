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
content types are served as media; other content is an opaque download.

The scheduled transcript-pruning workflow also removes evidence older than
`uiValidation.evidenceRetentionDays`. Evidence cleanup failures are logged without failing
transcript pruning. Size and per-run limits use the `uiValidation.maxScreenshotBytes`,
`uiValidation.maxVideoBytes` and `uiValidation.maxEvidencePerRun` settings. The
`uiValidation.agentRecordVideo` setting controls agent browser recording.

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
errors. E2E commands run with `CI=1`; the worker collects up to 30 PNGs, five WebM recordings and
five `trace.zip` files under the configured results directory. The app log tail is saved as `ui.log`.
Browser sessions are closed and their video and trace evidence is saved even when a check fails.

## Browser tool for agents

Mastra, Pi and Claude Code agents can use the browser tool only when `browser` appears explicitly in
their `toolKeys`. A null tool list never grants it. The toolset starts the configured preview on its
first call, defaults its navigation host allowlist to empty, and records screenshots before returning
their evidence identifiers. Snapshot, title and console text is screened before it is returned to
the agent. Session cleanup saves video and trace evidence and stops the app preview.

## PR evidence

The default PR body includes evidence counts and a dashboard link to the run's Evidence panel when
the run has evidence. The `uiValidation.prInlineImages` setting is off by default. Public image
copies are created only when that setting is enabled and both optional environment values are set:
`UI_EVIDENCE_PUBLIC_BUCKET` and `UI_EVIDENCE_PUBLIC_BASE_URL`. The worker copies at most six
screenshots to `ui-evidence/<runId>/<evidenceId>.png` without setting an ACL. Configure the public
bucket's read policy deliberately; the dashboard evidence remains access-controlled.

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
  admin setting are enabled. The public bucket's access policy is operator-managed.
