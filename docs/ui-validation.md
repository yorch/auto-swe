# UI validation

UI validation combines an in-container browser executor, run evidence storage, per-repository
preview recipes, a workflow gate and an explicitly granted agent browser tool. The browser executor
image is `defaults/Dockerfile.node-browser`; it includes the pinned Playwright runtime and Chromium.
`BrowserSession` drives the in-container browser, restricts navigation to configured hosts, and can
capture screenshots, video, traces and events.

Build a repository's browser executor by dispatching `build-executor.yml` for that repository with
`stack: node-browser` and `use_repo_dockerfile: false`. The workflow builds the curated image and
records the image and build settings on the repository connection. `docker.yml` also publishes
`executor-node-browser` for deployments that manage their own image references; set it as the
repository's `executorImage` when UI validation needs Chromium.

## Run evidence

Screenshots, recordings, traces and text logs use the workflow artifact store and carry run
metadata such as source, caption, page URL, workflow node, attempt and image dimensions. The run's
Evidence panel lists ready items, loads media through short-lived user-bound links and offers trace
and log downloads. Trace cards also open a self-hosted Playwright viewer at `/trace-viewer`, using
a freshly minted signed evidence URL. Each content request reloads the link owner's active account
and role and checks current run visibility before returning bytes. Only PNG, JPEG, WebP, WebM, ZIP
and plain text content types are served as media; other content is an opaque download. The content
route returns the whole object and does not implement range requests, so a recording downloads in
full before it can seek.

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
agent runs, and `agent` nodes with `workspace: true`; a node without a workspace has no browser tools.
The toolset starts the configured preview on its first call, defaults its navigation host allowlist to
empty, and records screenshots before returning their evidence identifiers. Snapshot, title and
console text is screened before it is returned to the agent. Session cleanup waits for a start already
in flight, then saves video and trace evidence and stops the app preview. One session serves the
whole toolset, so concurrent tool calls in a single model step share it.

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
containers have bounded resources and no-new-privileges. By default they run as root with
`CHOWN`, `SETUID`, `SETGID`, `FOWNER` and `DAC_OVERRIDE`; `runAsUser` selects a non-root uid and
drops all capabilities, while optional `runAsGroup` selects its group (defaulting to `runAsUser`).
A configured `readyCommand` is retried before the app preview starts. Kubernetes keeps service
environment values in the workspace's per-pod Secret rather than the Pod manifest. Agent
workspaces receive the recipe's services only when the agent has an explicit `browser` grant.

The worker's `startAppPreview` helper runs the recipe's optional setup (after the repository's
[workspace setup](./repositories.md#workspace-setup), with the recipe's env), starts the app in its own session (so
its pid is its process-group id and `stop()` can kill the whole tree), polls the readiness URL from
inside the workspace and returns a stop function and bounded, redacted log tail. It uses the
recipe's base URL, or the readiness URL's origin when none is supplied.

## Kubernetes kind integration test

`packages/worker/src/lib/workspaceBackend/kubernetes/driver.kind.test.ts` exercises the workspace
backend against the current Kubernetes context. It requires Docker, `kubectl` on `PATH`, the
`auto-swe-workspaces` namespace manifest applied, a CNI that enforces NetworkPolicy, and the
`auto-swe/node-browser:phase-a` and `mirror.gcr.io/library/postgres:18` images loaded on the
cluster's nodes. The test uses the caller's kubeconfig identity; it does not require a worker
ServiceAccount.

Run it with `K8S_KIND_TEST=1`. `K8S_KUBECTL` selects the kubectl binary, while
`K8S_WORKSPACE_NAMESPACE` and `K8S_WORKSPACE_RUN_AS_UID` select the namespace and workspace UID.
`K8S_KIND_EVIDENCE_DIR` is test-only and receives `workspace-preview.png`.

```bash
mkdir -p /path/to/k8s-evidence
set -o pipefail
K8S_KIND_TEST=1 \
K8S_KUBECTL=kubectl \
K8S_WORKSPACE_NAMESPACE=auto-swe-workspaces \
K8S_WORKSPACE_RUN_AS_UID=1000 \
K8S_KIND_EVIDENCE_DIR=/path/to/k8s-evidence \
yarn vitest run packages/worker/src/lib/workspaceBackend/kubernetes/driver.kind.test.ts \
  2>&1 | tee /path/to/k8s-evidence/kind-test.log
kubectl get events -n auto-swe-workspaces --sort-by=.lastTimestamp \
  > /path/to/k8s-evidence/events.log
```

The end-to-end case verifies that a non-root Postgres service runs under the unchanged `restricted`
namespace. A separate root-service case temporarily changes only the namespace's Pod Security
`enforce` label to `baseline`, then restores `restricted`; another case confirms that root services
are rejected under `restricted`. The workspace container remains non-root with all capabilities
dropped.

## Limitations

- Kubernetes preview services with `runAsUser` run under Pod Security `restricted`; services that
  run as root still require `baseline`. The workspace container keeps its non-root,
  dropped-capability security context.
- The stray-process sweep scopes signals to the workspace mount namespace. It relies on the workspace
  having no `CAP_SYS_ADMIN` and using the runtime-default seccomp profile to prevent `unshare` or
  `setns` from moving a process into another mount namespace to evade the sweep.
- Public PR images are intentionally unavailable unless both environment values and the explicit
  admin setting are enabled. The public bucket's access policy is operator-managed. Renaming the
  bucket after copies exist leaves the old copies behind: retention can only delete from the bucket
  the environment currently names.
- `stop()` signals the preview's process group and processes that retain its random environment
  mark. A daemon that scrubs the mark, or runs as a UID the worker cannot signal, can outlive
  `stop()` until the workspace is destroyed.
- A worker that dies between writing an artifact and creating its `RunEvidence` row leaves a ready
  `ui.*` artifact that no evidence row points at. The daily transcript sweep deletes those, and a
  pending write, after a day; until then the object is stored but unreachable from any run.
- Evidence bytes move through the worker on the way in: the recording is read out of the container
  and written to the artifact store in memory, so the `uiValidation.maxVideoBytes` cap bounds a
  single worker's memory use, and the step's wall-clock budget has to cover the transfer as well as
  the recording. Serving is streamed from the store, not buffered.
- A generic `agent` node can use the browser only with `workspace: true` and an explicit `browser`
  grant; a node without a workspace has no browser tools.
- Trace snapshots replay on the dashboard origin. Playwright strips scripts from snapshot HTML, but
  the content comes from the app under test.
- The browser tool's `browser_screenshot` persists the image as evidence but returns the accessible
  page snapshot and the evidence id to the model, not the pixels: an agent reads the page as text,
  and a person sees the picture on the run page.
