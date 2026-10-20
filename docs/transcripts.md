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
- `POST /api/v1/transcripts/:id/download-link` — a short-lived signed link to that stream (see [Download links](#download-links)).
- `POST /api/v1/transcripts/:id/verify` (ADMIN) — re-hashes every part's gzipped bytes and the transcript hash.
- `PUT` / `DELETE /api/v1/workflow-runs/:id/transcripts/legal-hold` (ADMIN, reason required on PUT) — sets or clears a run-wide retention hold in one transaction (the WorkflowRun columns plus every transcript's `runLegalHold*` copy).
- `PUT` / `DELETE /api/v1/transcripts/:id/legal-hold` (ADMIN) — an independent per-transcript hold (`legalHold*`), for a transcript whose run was deleted or which must outlive the others.

The two scopes are independent: releasing a run hold leaves per-transcript holds in place, and releasing a transcript's own hold leaves its run hold in place. `legalHold` in API metadata is the *effective* hold (either scope); `transcriptHold` and `runHold` report each scope. The sweep deletes only when both are false and the run itself is not held.
- `GET /api/v1/platform/transcripts/export` (ADMIN) — NDJSON export of `{ transcript, record }` lines over a date range (`from`/`to` required, ≤ 31 days; `format`, `scrubPii`, `agentKey`, `activityType` filters), across all tenants including runless transcripts.
- `GET /api/v1/platform/transcripts/access-log` (ADMIN) — the [access audit](#access-audit), newest first.

Authorization: list and metadata follow the run's visibility filter; **content** (and a download link for it) requires run *control* (owning team or requester) or ADMIN — a shared-repo teammate can see a run but not its raw model traffic. A runless transcript is ADMIN-only; a caller short of the bar gets 404. Service principals get `403 TRANSCRIPTS_NOT_AVAILABLE` on the ENGINEER routes and `401 SERVICE_TOKEN_NOT_ALLOWED` on the ADMIN ones, which do not admit service tokens at all.

## Access audit

Every content read, download-link issue, export, integrity verification and legal-hold change (run-wide and per-transcript) writes a `TranscriptAccessLog` row: the action (`content_read`, `download_link`, `export`, `verify`, `legal_hold_set`, `legal_hold_cleared`), its scope (`transcript`, `run` or `export`), the actor's id and role, the transcript and run ids, the request's parameters (format, scrubPii, the export's range and filters, a hold's reason, and `via` — `api` or `download_link`), the client IP and user agent, and an outcome. A content or export row is written *before* the stream starts, as `started`, and completed from the response itself — its listeners are attached before the row is inserted, so a client that leaves during the insert is still recorded: `ok` once the response has finished, `integrity_error` when a part failed verification (an export that carried on past one still ends `integrity_error`), `stream_error` when the read failed, `aborted` when the response closed before it finished. The transcript sweep marks a row still `started` an hour after it was written `aborted` (with `completedAt` set), which covers a gateway that died mid-stream. A verification ends `ok` or `integrity_error`; a hold change or a link issue is written once it has been applied, as `ok`. A 401 or 404 on the content or download-link route writes a `denied` row when the caller is identified — the signed-in user, or a download link's subject once its signature verified (status and `via` in its parameters, no run id); the response itself is the same whether or not the transcript exists. The rows have no foreign keys, so they outlive the user, run and transcript they name, and no tenant columns: the log is ADMIN-only. The gateway log keeps its own audit lines (`transcript_content_read`, `transcript_export`, `transcript_legal_hold_set` / `_cleared`) as well.

The failure policy is allow + alert: when the row cannot be written (or completed), the access still goes ahead, and the gateway logs a warning and counts `transcript.access_log_failures` (by action).

`GET /api/v1/platform/transcripts/access-log` (ADMIN; never callable by the in-app assistant) filters by `from`/`to` (ISO instants, `to` exclusive), `actorId`, `transcriptId`, `runId` and `action`, pages with `limit` (at most 200, default 50) and `offset`, and returns `{ data, total }` newest first, each row with the actor's email when the user still exists. The dashboard shows it on `/admin/audit` under **Transcript access**, with the same URL-kept filters as the change log. Rows are kept for `workflow.transcriptAccessLogRetentionDays` (default 2555 days, 365 to 3650) and pruned by the transcript sweep.

## Download links

A browser cannot attach the API bearer to a plain navigation, so the run page asks for a link instead: `POST /api/v1/transcripts/:id/download-link` with `{ format, scrubPii }` (same authorization as the content route) returns `{ url, expiresAt }`, where `url` is the relative content URL with `format`, `scrubPii` and a `dl` token. The browser then navigates to it and the attachment streams straight to disk — nothing is buffered in the page.

The token is `base64url(payload).base64url(HMAC-SHA256)`, keyed by an HKDF-SHA256 subkey of `CONFIG_ENCRYPTION_KEY` (info `auto-swe/transcript-download-link/v1`). The payload carries the version of the key it was signed under (`kv`), and verification uses that version's key from the keys the process holds — the current one or, during a rotation, `CONFIG_ENCRYPTION_KEY_PREVIOUS` — so a link issued just before a rotation still works; a version the process holds no key for is invalid. Its payload names the user, the transcript, the format and the PII choice, a random nonce, and an expiry 60 seconds out. Only the content route accepts `dl`, and only in place of a credential: the signature (compared in constant time), the expiry, the transcript id and the query's format and `scrubPii` must all match, the user must still exist, be active and hold at least the ENGINEER role, and the same run-control authorization runs again — a link outlives neither its holder's access nor its 60 seconds. A refused link answers `401 DOWNLOAD_LINK_EXPIRED` or `401 DOWNLOAD_LINK_INVALID`. The read is logged with `via: download_link`. The `dl` value is redacted from request logs and from the server span's `url.query`.

## Stream integrity

Every content or export stream ends with a `{"kind":"eof","complete":true}` sentinel. A part whose sha256 does not verify, whose gunzip output exceeds 64 MiB, or whose artifact cannot be read ends the stream with an `integrity_error` line (`reason: sha_mismatch` / `too_large` / `read_failed`) and a torn-down connection — a client must treat any stream without the eof line as incomplete. The CLI exits non-zero on that.

## Normalized view

`format=normalized` maps each record through `@auto-swe/shared/lib/transcripts/normalize` — Anthropic Messages (including thinking blocks and streamed `input_json_delta`), OpenAI Responses and chat completions (streamed or not), Google `generateContent`/`streamGenerateContent`, and Claude Code `harness_message`s — into one message/tool-call/tool-result shape with usage. A record that matches no known shape emits `{ normalized: null, record }`.

## Retention

`workflow.transcriptRetentionDays` (default 365) bounds storage. A daily Temporal schedule (`AGENT_TRANSCRIPT_PRUNE_ENABLED`, `AGENT_TRANSCRIPT_PRUNE_CRON`, default `57 4 * * *`) runs `pruneAgentTranscripts`: expired non-held transcripts are deleted (transcript row first — the part's `artifactId` is `Restrict`, so the artifacts cannot go first — then the artifacts; a leftover artifact is reaped by the orphan pass), `open` transcripts with no update in 24 h become `abandoned`, and orphaned `agent-transcript-part` artifacts older than 24 h are deleted. The same sweep deletes transcript access-log rows past `workflow.transcriptAccessLogRetentionDays`, in batches, and artifacts left `pending` for more than 24 h (below). `workflow.transcriptCaptureEnabled` (default `true`) turns recording off without touching existing rows.

On the S3 backend an artifact is written ahead of its object: the `WorkflowArtifact` row is created `pending` with its object key, then the object is uploaded, then the row is marked `ready`. A failed upload leaves its row `pending` and the error propagates — the store may have committed the object even though the call failed. `getArtifact` refuses a row that is not `ready`, and the readers that treat an artifact row as present evidence (quality-gate evidence, knowledge capture) filter on `ready`. A failed upload, or a writer that dies between the two, leaves a `pending` row naming the object; the sweep walks those older than 24 h in batches, deleting the object (a missing one counts as deleted) and then the row. A deletion that fails is logged, counted (`pendingArtifactFailures` in the sweep's result) and retried on the next sweep without stopping the passes after it. The Postgres backend writes its row and payload in one insert and has no pending state.

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
- The access log is allow + alert: when its write fails the read still happens, and only the warning and the `transcript.access_log_failures` counter record it. Like the transcripts, its rows are not WORM — anyone who can write the table can edit or delete them.
- A stream's outcome is recorded from the gateway's side: `ok` means the response finished — every byte handed to the socket — not that the client stored it. A gateway that dies mid-stream leaves its row `started` until the next sweep marks it `aborted`, so that outcome also covers a crash.
- A refusal is recorded only when the caller is identified — a signed-in user, or a download link whose signature verified (an expired one included). An unauthenticated request, or one carrying a forged or malformed link, writes no row, so anonymous callers cannot grow the table; such refusals appear only in the gateway's request log.
- Download links are not single-use: within its 60 seconds a link can be replayed by whoever holds it (each use is logged). Once a rotation drops `CONFIG_ENCRYPTION_KEY_PREVIOUS`, links signed under it stop verifying.
- The `pending` artifact sweep runs inside the transcript prune schedule, so with `AGENT_TRANSCRIPT_PRUNE_ENABLED=false` an object whose upload outlived its writer is never deleted; an S3 object with no row at all (left by a version that uploaded before inserting its row) is not found by any sweep.
