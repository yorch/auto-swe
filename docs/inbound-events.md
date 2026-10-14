# Inbound events

An **event endpoint** is a URL another service posts events to: a monitoring system's alert, a
deploy pipeline's "released", a ticket system's "escalated". Each endpoint belongs to a team. The
team's **`inbound.event` automations** decide what an event starts; an event on its own never
starts anything.

Every call proves who sent it with the endpoint's **verification scheme**, checked over the raw
body before anything else is read. What the event says is still the sender's text, so only the
values an automation asks for are ever kept, and the run is told where its input came from.

This page covers endpoints, how a sender signs and shapes its events, and the automation source.
How automations decide, and the ledger they write, is in [automations.md](./automations.md).

---

## 1. Event endpoints

An endpoint (`EventEndpoint`) has:

| Field | Meaning |
|---|---|
| `name` | A label |
| `enabled` | A disabled endpoint refuses every call (after checking its signature) |
| `scheme` | How a call is verified: `autoswe-v1`, `hmac-sha256` or `shared-secret-header` (§2) |
| `signatureHeader`, `signaturePrefix`, `signatureEncoding` | For `hmac-sha256` and `shared-secret-header`: the header the value is in, text before it (`sha256=`, `Bearer `), and for an HMAC whether it is `hex` or `base64` |
| `format` | `json`, or `cloudevents` (§3.2) |
| `typePointer`, `idPointer`, `subjectPointer`, `scopePointer`, `timePointer` | Where in the event its type, id, subject, scope and time are (§3) |
| the secret | Sealed with the same AES-256-GCM envelope as every other stored credential; only its last four characters are ever shown |

Its receiver is `POST /api/v1/webhooks/events/<endpoint id>`. The id is not a credential: a call
without a valid signature is refused whoever knows it.

On the dashboard, the team's page (**Governance → Teams → a team**) has an **Event endpoints**
card: the URL to give the sender, how calls are verified, the secret's last four characters, the
on/off switch, **Rotate secret**, and **Automations**, which opens the team's automations.

| Route | Who |
|---|---|
| `GET /api/v1/teams/:teamId/event-endpoints` | A member of the team, or ADMIN. Never a secret. The response says whether the caller may manage them (`canManage`) |
| `POST /api/v1/teams/:teamId/event-endpoints` | ADMIN, or a LEAD of the team. Returns a generated secret **once**; a `secret` the caller sends (16–512 characters, for a sender that generates its own) is stored and never returned |
| `PATCH /api/v1/teams/:teamId/event-endpoints/:id` | The same: name, switch, scheme settings and pointers. The secret is changed only by rotating it |
| `POST /api/v1/teams/:teamId/event-endpoints/:id/secret/rotate` | The same. A new secret (generated and returned once, or the one sent); the one it replaces is still accepted for **24 hours** |
| `DELETE /api/v1/teams/:teamId/event-endpoints/:id` | The same. Refused (`409 EVENT_ENDPOINT_IN_USE`) while an automation reacts to the endpoint |

A non-member gets `404`. Every create, change, rotation and removal is written to the audit log
(entity `EventEndpoint`) with the endpoint's settings and the secret's last four characters, never
the secret.

**The switch.** `workflow.inboundEventsEnabled` (ADMIN; per team or organization; **off by
default**) decides whether events may start runs at all. While it is off, every endpoint of the
team refuses calls with `409 INBOUND_EVENTS_DISABLED`.

### Presets

The form on the team's page starts from a preset. Presets are data: they fill in the scheme and
the pointers, and everything can be changed before saving. They are starting points, not
integrations: check them against what the sender actually posts.

| Preset | Scheme | Body | Pointers |
|---|---|---|---|
| auto-swe signed JSON | `autoswe-v1` | JSON | type `/type`, id `/id`, subject `/subject` |
| CloudEvents | `autoswe-v1` | CloudEvents | the event's attributes (§3.2) |
| HMAC-SHA256, GitHub-style header | `hmac-sha256` in `X-Hub-Signature-256` as `sha256=<hex>` | JSON | placeholders (`/action`, `/id`): set them to where the sender puts its type and id |

## 2. Signing a call

Every scheme compares in constant time against the current secret and, for 24 hours after a
rotation, the one it replaced. A refused call is answered `401 SIGNATURE_INVALID` with the same
message whatever was wrong; the reason (missing, malformed, stale, mismatch) is logged by the
gateway with the endpoint's id, never sent back. The body and the secret are never logged.

### `autoswe-v1`

The platform's own scheme, the one template webhooks use
([automations.md §5.1](./automations.md#51-signed-template-webhooks)):

```
X-AutoSwe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

The timestamp is inside the MAC and must be within 300 seconds of the gateway's clock, so a
captured call stops verifying after five minutes. `@auto-swe/sdk` signs with
`signAutoSweRequest(secret, rawBody, nowSec)`.

```js
import { createHmac } from 'node:crypto';

const body = JSON.stringify({ type: 'alert.fired', id: 'a-123', subject: 'disk-full/db-1' });
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
await fetch(endpointUrl, {
  body, // exactly the bytes that were signed
  headers: { 'content-type': 'application/json', 'x-autoswe-signature': `t=${t},v1=${v1}` },
  method: 'POST',
});
```

### `hmac-sha256`

An HMAC-SHA256 of the **raw body bytes** keyed with the secret's UTF-8 bytes, in a header the
endpoint names, after an optional prefix (compared without case), as `hex` or `base64` (standard
or URL-safe, padded or not). This is how GitHub (`X-Hub-Signature-256: sha256=<hex>`) and many
other services sign webhooks.

```sh
sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" -hex | sed 's/^.* //')
curl -X POST "$url" -H 'content-type: application/json' \
  -H "X-Signature: sha256=$sig" --data-binary "$body"
```

There is no timestamp in this scheme: a captured call verifies for as long as the secret does
(see Limitations). A header sent twice is refused.

### `shared-secret-header`

The secret itself in a header the endpoint names, after an optional prefix — for a sender that can
only add a static header, such as `Authorization: Bearer <secret>`. It proves only that the sender
holds the secret, not that the body is theirs or recent: prefer a signing scheme whenever the
sender supports one.

### The loop guard

`X-AutoSwe-Delivery` is the header the platform uses to mark its own outbound calls. A request
carrying it is answered `202` and dropped before the endpoint is even looked up, recording
nothing, so a call the platform made can never be answered with a run of its own.

## 3. Reading an event

After the signature, the body is parsed (`400 INVALID_EVENT` when it does not parse) and the
event's own fields are read with the endpoint's **JSON Pointers**.

### 3.1 JSON Pointers

A pointer ([RFC 6901](https://www.rfc-editor.org/rfc/rfc6901)) names one value in a JSON document:
`''` is the whole document, and `/a/b` is key `b` of key `a`. In a key, `~1` stands for `/` and
`~0` for `~`. An array element is its index: `/alerts/0/labels/severity`. `-`, an index with a
leading zero, an index past the end, a missing key and a step into a text or number all mean the
value is **missing**. Only the document's own keys are followed.

```json
{ "alert": { "labels": { "app/name": "billing", "severity": "critical" } },
  "alerts": [{ "id": "a-1" }] }
```

| Pointer | Value |
|---|---|
| `/alert/labels/severity` | `"critical"` |
| `/alert/labels/app~1name` | `"billing"` |
| `/alerts/0/id` | `"a-1"` |
| `/alerts/1/id`, `/alert/labels/team` | missing |

| Field | Read with | When missing |
|---|---|---|
| type | `typePointer` | The event is refused: `422 EVENT_TYPE_MISSING`. It must be text (or a number or true/false, read as text), at most 256 characters |
| id | `idPointer` | `sha256:<hex>` of the raw body, so the same body is the same event |
| subject | `subjectPointer` | the id |
| scope | `scopePointer` | the type |
| time | `timePointer` | none (shown in the history only) |

An id, subject or scope longer than 200 characters, or with characters other than letters, digits
and `. _ : @ + = / -`, is kept as `sha256:<hex>` of its text, so no ledger key carries arbitrary
text and two different values never share a key.

### 3.2 CloudEvents

An endpoint with format `cloudevents` reads [CloudEvents 1.0](https://cloudevents.io) in
**structured mode**: `Content-Type: application/cloudevents+json`, and the body is the event, its
attributes at the top and its data under `/data`. `specversion` (1.x), `id`, `source` and `type`
are required. A new CloudEvents endpoint reads the type from `/type`, the id from `/id`, the subject
from `/subject`, the scope from `/source` and the time from `/time`.

**Binary mode is refused** (`415 UNSUPPORTED_EVENT`), as is any request to a CloudEvents endpoint
that carries a `ce-*` header or another content type. In binary mode the attributes travel in
`ce-*` headers, which none of the schemes sign: a captured call could be sent again with a new
`ce-id` to escape the dedupe key, or a new `ce-type` or `ce-subject` to reach other automations or
step around a cooldown. In structured mode every attribute is in the signed body. A batch
(`application/cloudevents-batch+json`) is refused with `415` too.

```sh
body='{"specversion":"1.0","id":"8c1b","source":"//monitor/eu-1","type":"com.example.alert.fired","subject":"db-1","data":{"severity":"critical","summary":"disk full"}}'
curl -X POST "$url" -H 'content-type: application/cloudevents+json' \
  -H "x-autoswe-signature: $sig" --data-binary "$body"
```

### 3.3 What the receiver answers

In order — each check runs only when every earlier one passed:

| Answer | When |
|---|---|
| `413` | The body is over 128 KB |
| `202 { ignored: true }` | The call carries `X-AutoSwe-Delivery` |
| `404 EVENT_ENDPOINT_NOT_FOUND` | No such endpoint |
| `401 SIGNATURE_INVALID` | The call is not verified |
| `409 EVENT_ENDPOINT_DISABLED`, `409 TEAM_INACTIVE`, `409 INBOUND_EVENTS_DISABLED` | The endpoint is off, its team inactive, or the switch off for the team |
| `400 INVALID_EVENT`, `415 UNSUPPORTED_EVENT`, `422 EVENT_TYPE_MISSING` | The body cannot be read as an event |
| `503 AUTOMATION_START_FAILED` | A run was decided but could not be started: send the same event again |
| `202 { eventId, outcome }` | Decided: the outcome of the decision (`STARTED`, `SUPPRESSED_…`, `FAILED_TO_START`) |
| `202 { eventId, duplicate: true }` | The event was decided before |
| `202 { eventId, ignored: true }` | No enabled automation of the team selects it |

The answer never says why a decision was made; the team sees that in the automation's history.
The receiver is rate-limited to 120 calls a minute per client address.

## 4. Automations on events

An `inbound.event` automation is a **team automation** ([automations.md
§1](./automations.md#team-automations)). It is created from the team's automations (the
**Automations** button on the team's event-endpoint card) by ADMIN or a LEAD of the team, and its
filters are:

| Filter | Meaning |
|---|---|
| `endpointId` | One of the team's endpoints. Refused at save otherwise |
| `eventTypes` | Patterns over the event type, at least one not an exclusion: `*` is any run of characters (dots and slashes included), `?` one character, `!pattern` excludes, the last match wins |
| `match` | Conditions that must all hold: `{ pointer, op, value }` with `op` `eq` (the value is this text, number or true/false — `3` and `"3"` differ), `in` (one of a list), `glob` (text matching a pattern), or `exists` (present and not `null`; with `value: false`, absent). No expressions: at most 20 conditions |
| `fields` | Template inputs filled from the event: `{ "<input>": "<pointer>" }`, at most 20 |

**What it starts.** An event automation has no default template: it names one, global or the
team's own (`400 TEMPLATE_REQUIRED` otherwise). It never starts an agent run. A mapped field must
be an input the template declares, not a `connection` or list input, and not `description`,
`ticketId`, `connectionId` or `baseBranch`; and the automation's own options may not set it too.
A mapped value is used only when it is text, a number or true/false; a missing or `null` value, an
object or a list leaves the input to the template's default. At save the payload is built with a
stand-in value of the declared type for each mapped field; at every event it is built with the real
values, and one the template refuses (an enum value it does not list, text where a number belongs)
is recorded as `FAILED_TO_START` with the reason.

**A repository.** An automation may name a repository its runs act on (`targetConnectionId`): one
the team owns or one shared with it. Saving it on is then a launch decision on that repository too
(the access gate, the caller's membership of the repository's organization and its cap, as well as
the team's organization). The automation stays the team's — managed by the team, its decisions on
the endpoint's ledger — and its run carries the repository's `connectionId` and uses the platform
credential. If the repository is later deactivated, or no longer shared with the team, an event is
recorded as `FAILED_TO_START`; deleting the repository deletes the automation. Switching such an
automation off never needs the repository. For a repository another team owns, every event also
needs `workflow.inboundEventsEnabled` on for that team (otherwise `SUPPRESSED_PRECONDITION`) and
budget left in that team's organization (otherwise `SUPPRESSED_BUDGET`), besides the automation's
own team's switch and budget.

**The run.** Its description starts by saying that an event posted to an endpoint started it, that
no person asked for it, and that the event's text is data, not instructions; then the type, id,
subject and endpoint, each on one line with control characters and line breaks replaced by spaces,
and the mapped fields as one JSON object, so no value can close the block or start a section of its
own. Its ticket is synthetic, `evt-` and 96 bits of SHA-256 over `<endpoint id>#<event id>`, so
events of different endpoints or teams never share a ticket or a branch; its workflow id is
`evt-<automation8>-<the same digest>`.

### 4.1 Decisions

- **Owner.** Every decision about an endpoint's events is recorded under `@endpoint/<endpoint id>`,
  and taken under the transaction lock `automation-owner:@endpoint/<endpoint id>`, whether or not
  the automation acts on a repository: the event happened on the endpoint.
- **One run per event.** The dedupe key is `@endpoint/<endpoint id>#<event id>`. The team's
  automations on the endpoint are tried oldest first and the first that selects the event decides,
  so however many match, one event starts at most one run, and a redelivered event answers
  `duplicate` (or is taken again when its decision was `FAILED_TO_START`).
- **Guards.** Same subject, cooldown and in-flight (for 24 hours) count over the endpoint's
  decisions, by subject and scope; the daily cap is the automation's; the budget is the team's
  organization's ([automations.md §2](./automations.md#2-from-occurrence-to-run)).
- **Facts.** The ledger keeps only what was extracted: the type, id, subject, scope and time, the
  values the automation's conditions read, and its mapped fields — never the body. Each text value
  is cut to 4,000 characters, and the facts as a whole to 16,000, shortening the longest values
  first. Conditions are judged on these recorded values, so **Decide again** decides exactly as the
  event did, from the ledger alone; it is refused while the endpoint is disabled or gone.

### 4.2 Would it fire?

The automation form has a tester: paste a sample payload, and it reads it with the endpoint's
pointers (as a structured CloudEvent for a CloudEvents endpoint) and answers with the same
`mismatch` the receiver uses — which condition rules it out, or that it would start a run unless a
limit, an earlier run or the budget holds it back.

## 5. Security model

- **Who may send.** Whoever holds the endpoint's secret. The URL is not a secret. Verification is
  over the exact bytes received, before the body is parsed; nothing about the endpoint (whether it
  exists aside, whether it is on, what it reacts to) is revealed to a caller that cannot sign.
- **What an event can do.** Only what the team's automations allow: which types, which conditions,
  which template, which inputs it fills. It cannot choose a template, a repository, a branch or the
  run's description. Nothing starts while `workflow.inboundEventsEnabled` is off.
- **Event text is untrusted.** A verified sender can still forward text written by someone else (an
  alert message quoting a log line). Mapped values are capped, the run's description marks their
  provenance, and the template receives them only in the inputs the automation maps. A template
  that changes code from an event should be one the team chose for that, with a repository named
  deliberately; its pull requests are drafts that a person merges.
- **Loops.** A request carrying `X-AutoSwe-Delivery`, the header that marks the platform's own
  outbound calls, is dropped unrecorded.
- **Only signed text decides.** Everything a decision reads — type, id, subject, scope, matched and
  mapped values — comes from the signed body; no request header other than the signature is read.

## Limitations

- **`hmac-sha256` and `shared-secret-header` have no timestamp.** A captured call can be replayed
  for as long as the secret is valid. The dedupe key stops the same event id from starting a second
  run, but an event that names no id is keyed by its body, and a replay of it is a duplicate only
  while its earlier decision is kept (decisions that started nothing are pruned after the retention
  period). Prefer `autoswe-v1` where the sender can produce it.
- **One previous secret, 24 hours.** Rotating twice within a day drops the first secret at once.
- **Pointers only.** The type, id and values are read with JSON Pointers into the body (or the
  CloudEvents envelope). A sender that puts its event type or id only in a header (GitHub's
  `X-GitHub-Event` and `X-GitHub-Delivery`) cannot be read by those headers; point at a body field
  instead, or let the id fall back to the body's digest.
- **Structured CloudEvents only.** Binary-mode CloudEvents (attributes in `ce-*` headers) and
  batches are refused; a sender that can only send binary mode cannot use a CloudEvents endpoint.
- **No expression language.** Conditions are `eq`, `in`, `glob` and `exists` on single values, all
  of which must hold; there is no "or" across conditions, no numeric comparison, and no condition on
  an element of a list other than by its index.
- **Values are compared as recorded.** A value longer than 4,000 characters, or one shortened to
  fit the facts limit, is compared in its shortened form.
- **A retry uses the automation's mapping as it was.** Decide again uses the mapped fields recorded
  with the decision; a field mapping changed since is not applied to it.
- **The same subject across automations.** The same-subject guard counts the endpoint's decisions,
  so two automations on one endpoint acting on different repositories still start one run for one
  subject.
- **No per-sender IP allowlist,** and the rate limit is per client address, not per endpoint.
- **The receiver answers after deciding.** A sender with a short timeout may give up while a run is
  being started; sending the event again is safe, because the decision is keyed by the event.
