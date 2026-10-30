# UI validation

UI validation combines an in-container browser executor, run evidence storage and per-repository
preview recipes. The browser executor image is `defaults/Dockerfile.node-browser`; it includes the
pinned Playwright runtime and Chromium. `BrowserSession` drives the in-container browser, restricts
navigation to configured hosts, and can capture screenshots, video, traces and events.

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
`uiValidation.agentRecordVideo` setting controls agent browser recording. The
`uiValidation.prInlineImages` setting is reserved; evidence is not copied to a public bucket by
this pipeline.

## Repository preview recipes

A `git_repo` connection can hold a `previewConfig` JSON recipe. The shared strict schema checks the
setup and start commands, local readiness and base URLs, environment variables, allowed browser
hosts, smoke paths, optional end-to-end command and results directory, and service descriptions.
Changing a recipe takes the same team shell-authoring role as changing gate commands; unchanged
recipes can be saved by other repository editors.

The worker's `startAppPreview` helper runs optional setup, starts the app with configured
environment values, polls the readiness URL from inside the workspace and returns a stop function
and bounded, redacted log tail. It uses the recipe's base URL, or the readiness URL's origin when
none is supplied.

## Limitations

- A recipe can be stored and started by the worker helper, but no workflow step invokes it
  automatically or evaluates its smoke and end-to-end entries.
- The `services` field is validated as recipe data; workspace sidecars do not start from it.
- The Evidence panel serves evidence already attached to a run; it does not create public pull
  request images, and a browser agent tool is not available.
