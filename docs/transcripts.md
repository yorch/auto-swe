# Agent transcripts

> Full-fidelity record of every model call an activity attempt makes, for debugging, evals, training data, and audit.

Each activity attempt gets one `AgentTranscript` row, created lazily on its first record. Its payload is a sequence of gzipped NDJSON parts stored as `WorkflowArtifact` rows (`agent-transcript-part`, no runId — a deleted run does not take its transcripts), each with a sha256; the transcript's own `sha256` hashes the ordered part hashes, so a reader can verify integrity end-to-end.

## What is recorded

- **`http_call`** — every call through the worker's model fetch: method, host, sanitized path, status, duration, request body, response body. Headers are never stored, and credential query parameters (`key`, `token`, `api_key`, …) are stripped before the path is written.
  - **Embedding calls** (`lib/embeddings.ts`, every activity that embeds, bulk re-embedding included) are `http_call`s with `purpose: 'embedding'`. The request — the embedded inputs — is kept in full; each vector in the response is replaced by `{ omitted: 'vector', dimensions }` (OpenAI and OpenAI-compatible `data[].embedding`, Google `embedding.values` and `embeddings[].values`) whenever the body parses as JSON, whatever its content-type. They do not count toward the transcript's `modelCallCount`.
- **`harness_turn`** — written as every Claude Code turn starts, proxied or not: the model, `proxied`, the system prompt as `{ preset: 'claude_code', sha256, append }` — the full appended text on the adapter's first turn in a transcript and whenever its sha256 changes, otherwise `{ preset, sha256, unchanged: true }` (with `stagedPath` when a prompt too long for the command line was staged as a file; `append` then still holds the full text), the tool names, `maxTurns`, the MCP server names, `loadProjectSettings`, and the effort. It carries no endpoint, key, or MCP server address.
- **`harness_message`** — Claude Code SDK stream messages, only for non-proxied turns; a proxied turn's exchanges arrive through the model proxy's `onExchange` instead.
- **`harness_session_file`** — after every non-proxied Claude Code turn that ended without cancellation or its deadline (a failed turn included), what the turn added to the harness's session JSONL file (the first regular file matching `$HOME/.claude/projects/*/<sessionId>.jsonl` in the container): `{ sessionId, path, offset, bytes, truncated, lines }`, each line parsed (a line that does not parse is kept as its string). Turns resume one session, so each records only the bytes after the previous turn's offset, capped at 4 MiB per turn (`truncated: true`; the next turn continues from where the cap stopped). `bytes` is what the read delivered — the delta is copied to a temp file in the container first — so a file that grows during the read loses nothing. A file shorter than the offset (rewritten or compacted) is read from 0 and the record carries `reset: true`. The offset advances only when the record is stored, so bytes a dropped record held are read again by the next turn; once the transcript is closed or past its cap, no more reads run. The read runs in the background — the turn returns without waiting, and the recorder's close drains it — each read waits (up to 10 s) for the previous one so offsets stay in order, and is itself bounded to 10 s. A missing file, a failed read, or a session id that is not a UUID records nothing and never fails the turn.
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

`format=normalized` maps each record through `@auto-swe/shared/lib/transcripts/normalize` — Anthropic Messages (including thinking blocks and streamed `input_json_delta`), OpenAI Responses and chat completions (streamed or not), Google `generateContent`/`streamGenerateContent`, and Claude Code `harness_message`s — into one message/tool-call/tool-result shape with usage. Every normalized call carries `source` — `http_call`, `harness_message`, or `harness_session_file` — so a reconstruction is never mistaken for a real Messages API call. A `harness_session_file` normalizes to one `anthropic` call whose messages are the delta's main-conversation user and assistant lines, with the model those lines name, and whose `response.usage` sums the assistant lines' usage (the last report per message id, sidechain calls included); sidechain (subagent) lines, summaries, and unparsed lines stay in the raw record only. Embedding calls (by `purpose`, or by an `/embeddings`, `:embedContent`, or `:batchEmbedContents` path) and `harness_turn` records are not conversations and normalize to `null`, as does a record that matches no known shape: it emits `{ normalized: null, record }`.

## Retention

`workflow.transcriptRetentionDays` (default 365) bounds storage. A daily Temporal schedule (`AGENT_TRANSCRIPT_PRUNE_ENABLED`, `AGENT_TRANSCRIPT_PRUNE_CRON`, default `57 4 * * *`) runs `pruneAgentTranscripts`: expired non-held transcripts are deleted (transcript row first — the part's `artifactId` is `Restrict`, so the artifacts cannot go first — then the artifacts; a leftover artifact is reaped by the orphan pass), `open` transcripts with no update in 24 h become `abandoned`, and orphaned `agent-transcript-part` artifacts older than 24 h are deleted. `workflow.transcriptCaptureEnabled` (default `true`) turns recording off without touching existing rows.

The run page's Transcripts section lists each attempt's transcript with a download link (raw or normalized) and an ADMIN-only legal-hold toggle that asks for a reason.

## Limitations

- `http_call` and `harness_message` capture model traffic through the worker fetch and the Claude proxy/harness only — a runtime that shells out to a model API outside `modelFetch` is not recorded.
- A non-proxied Claude Code turn records no HTTP exchange, so the text of the built-in `claude_code` preset prompt and the JSON schemas of the harness's tools are not in the transcript — only the appended prompt and the tool names are (`harness_turn`). Through the model proxy, every request is recorded whole.
- A non-proxied turn's session-file delta is capped at 4 MiB per turn; a turn that writes more records the rest only if a later turn of the same session runs. A read that fails, exceeds its 10 s bound, or lands after the transcript closed leaves that turn without a `harness_session_file` (the next turn's read starts from the same offset), and a turn stopped by cancellation or its deadline is not read at all — a later turn's read picks its bytes up.
- A session-file delta whose record still exceeds 16 MiB (pathological escaping of unparseable lines) is replaced by a `record_truncated` marker and its offset does not advance, so later turns re-read it and it is never stored.
- Embedding inputs are recorded in full, so bulk re-embedding (`reembedMemory`) can fill `workflow.transcriptMaxBytes` on its own; past the cap, the rest of the attempt goes unrecorded.
- Redaction is key-name- and pattern-based at write time; a secret under an unrecognized key survives into the part.
- The PII scrub is regex- and Luhn-based and only ever applies to string fields — it catches what its patterns catch, nothing more, and only when requested at read/export.
- gzip compresses within a ~32 KB window, so a part does not deduplicate repeated context across calls — long sessions are large; `workflow.transcriptMaxBytes` bounds them.
- A record that arrives after close's 10 s drain lands only as a `record_dropped` marker (or, once the row is final, as a log + counter); an activity killed mid-attempt leaves an `abandoned` transcript with whatever parts flushed.
- `runId` survives a deleted run only while the transcript does — retention still applies, and a runless transcript is readable by ADMIN only.
- sha256 detects corruption or tampering of the stored objects; it is not WORM — someone who can rewrite the transcript/part rows holding the hashes can resign edited content.
- The value-shape redactor is pattern-based and misses secret formats it has no pattern for.
- A record over 16 MiB is stored truncated (a `record_truncated` marker, head kept) — full fidelity is bounded by that per-record cap as well as the transcript cap.
- Transcript reads are audit-logged to the gateway log, not a dedicated audit table.
