# Agent transcripts

> Full-fidelity record of every model call an activity attempt makes, for debugging, evals, training data, and audit.

Each activity attempt gets one `AgentTranscript` row, created lazily on its first record. Its payload is a sequence of gzipped NDJSON parts stored as `WorkflowArtifact` rows (`agent-transcript-part`, no runId — a deleted run does not take its transcripts), each with a sha256; the transcript's own `sha256` hashes the ordered part hashes, so a reader can verify integrity end-to-end.

## What is recorded

- **`http_call`** — every call through the worker's model fetch: method, host, sanitized path, status, duration, request body, response body. Headers are never stored, and credential query parameters (`key`, `token`, `api_key`, …) are stripped before the path is written.
- **`harness_message`** — Claude Code SDK stream messages, only for non-proxied turns; a proxied turn's exchanges arrive through the model proxy's `onExchange` instead.
- **`marker`** — `truncated` (the run hit `workflow.transcriptMaxBytes`), `record_dropped` (a record arrived after the activity ended).

Secrets are redacted at write time (the same `redactJsonValues` used by trace capture) with no truncation; the PII scrub is applied only at read/export, opt-in via `scrubPii=true`. Persistence is best-effort: a failed part write marks the transcript `incomplete`, logs, counts `transcript.persist_failures`, and writes a `transcript.persist_failed` trace event — never failing the activity. Transcripts still streaming when the activity returns are drained (bounded to 10 s) before the row closes; the interceptor's whole close is bounded to 30 s so a hung artifact store cannot stall the activity.

## Reading transcripts

- `GET /api/v1/workflow-runs/:id/transcripts` — a run's transcripts (visible iff the run is).
- `GET /api/v1/transcripts/:id` — metadata plus part hashes.
- `GET /api/v1/transcripts/:id/content` — the records as an NDJSON stream (`?format=raw|normalized`, `?scrubPii=true`).
- `POST /api/v1/transcripts/:id/verify` (ADMIN) — re-hashes every part's gzipped bytes and the transcript hash.
- `PUT` / `DELETE /api/v1/workflow-runs/:id/transcripts/legal-hold` (ADMIN, reason required on PUT) — sets or clears a run-wide retention hold in one transaction (the WorkflowRun columns plus every transcript's `runLegalHold*` copy).
- `PUT` / `DELETE /api/v1/transcripts/:id/legal-hold` (ADMIN) — an independent per-transcript hold (`legalHold*`), for a transcript whose run was deleted or which must outlive the others.

The two scopes are independent: releasing a run hold leaves per-transcript holds in place, and releasing a transcript's own hold leaves its run hold in place. `legalHold` in API metadata is the *effective* hold (either scope); `transcriptHold` and `runHold` report each scope. The sweep deletes only when both are false and the run itself is not held.
- `GET /api/v1/admin/transcripts/export` (ADMIN) — NDJSON export of `{ transcript, record }` lines over a date range (`from`/`to` required, ≤ 31 days; `format`, `scrubPii`, `agentKey`, `activityType` filters), across all tenants including runless transcripts.

Authorization: list and metadata follow the run's visibility filter; **content** requires run *control* (owning team or requester) or ADMIN — a shared-repo teammate can see a run but not its raw model traffic. A runless transcript is ADMIN-only; service principals get `403 TRANSCRIPTS_NOT_AVAILABLE` on every route; a caller short of the bar gets 404. Content reads and exports are audit-logged to the gateway log (`transcript_content_read`, `transcript_export`).

## Stream integrity

Every content or export stream ends with a `{"kind":"eof","complete":true}` sentinel. A part whose sha256 does not verify, whose gunzip output exceeds 64 MiB, or whose artifact cannot be read ends the stream with an `integrity_error` line (`reason: sha_mismatch` / `too_large` / `read_failed`) and a torn-down connection — a client must treat any stream without the eof line as incomplete. The CLI exits non-zero on that.

## Normalized view

`format=normalized` maps each record through `@auto-swe/shared/lib/transcripts/normalize` — Anthropic Messages (including thinking blocks and streamed `input_json_delta`), OpenAI Responses and chat completions (streamed or not), Google `generateContent`/`streamGenerateContent`, and Claude Code `harness_message`s — into one message/tool-call/tool-result shape with usage. A record that matches no known shape emits `{ normalized: null, record }`.

## Retention

`workflow.transcriptRetentionDays` (default 365) bounds storage. A daily Temporal schedule (`AGENT_TRANSCRIPT_PRUNE_ENABLED`, `AGENT_TRANSCRIPT_PRUNE_CRON`, default `57 4 * * *`) runs `pruneAgentTranscripts`: expired non-held transcripts are deleted (transcript row first — the part's `artifactId` is `Restrict`, so the artifacts cannot go first — then the artifacts; a leftover artifact is reaped by the orphan pass), `open` transcripts with no update in 24 h become `abandoned`, and orphaned `agent-transcript-part` artifacts older than 24 h are deleted. `workflow.transcriptCaptureEnabled` (default `true`) turns recording off without touching existing rows.

The lesson writer reads a run's newest implementer transcripts for a code-built digest of failed tools and commands, churned files and final notes ([memory.md §2](./memory.md#2-writing-lessons)).

The run page's Transcripts section lists each attempt's transcript with a download link (raw or normalized) and an ADMIN-only legal-hold toggle that asks for a reason.

## Limitations

- `http_call` and `harness_message` capture model traffic through the worker fetch and the Claude proxy/harness only — a runtime that shells out to a model API outside `modelFetch` is not recorded.
- Redaction is key-name- and pattern-based at write time; a secret under an unrecognized key survives into the part.
- The PII scrub is regex- and Luhn-based and only ever applies to string fields — it catches what its patterns catch, nothing more, and only when requested at read/export.
- gzip compresses within a ~32 KB window, so a part does not deduplicate repeated context across calls — long sessions are large; `workflow.transcriptMaxBytes` bounds them.
- A record that arrives after close's 10 s drain lands only as a `record_dropped` marker (or, once the row is final, as a log + counter); an activity killed mid-attempt leaves an `abandoned` transcript with whatever parts flushed.
- `runId` survives a deleted run only while the transcript does — retention still applies, and a runless transcript is readable by ADMIN only.
- sha256 detects corruption or tampering of the stored objects; it is not WORM — someone who can rewrite the transcript/part rows holding the hashes can resign edited content.
- The value-shape redactor is pattern-based and misses secret formats it has no pattern for.
- A record over 16 MiB is stored truncated (a `record_truncated` marker, head kept) — full fidelity is bounded by that per-record cap as well as the transcript cap.
- Transcript reads are audit-logged to the gateway log, not a dedicated audit table.
