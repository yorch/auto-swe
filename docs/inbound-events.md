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
| `typePointer` or `fixedType`, `idPointer`, `subjectPointer`, `scopePointer`, `timePointer` | Where in the event its type, id, subject, scope and time are, or for the type a constant `fixedType` instead (§3.1.1). Exactly one of `typePointer` and `fixedType` is set |
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
| Snyk project snapshot | `hmac-sha256` in `X-Hub-Signature` as `sha256=<hex>` | JSON | constant type `project_snapshot/v0`, subject and scope `/project/id`, no id pointer (§6) |
| PagerDuty v3 webhook | `hmac-sha256` in `X-PagerDuty-Signature` as `v1=<hex>` | JSON | type `/event/event_type`, id `/event/id`, subject `/event/data/id`, scope `/event/data/service/id`, time `/event/occurred_at` (§7) |

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

The header may carry a comma-separated list of signatures (`v1=<hex>, v1=<hex>`), at most 8. This
is how PagerDuty signs while one of its secrets rotates: once with each. Entries without the
endpoint's prefix are skipped, so a scheme version the endpoint was not set up for is never read as
a digest, and the call verifies when any listed signature matches any of the endpoint's secrets. A
header with no entry that decodes is malformed.

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
| type | `fixedType` if set, else `typePointer` | The event is refused: `422 EVENT_TYPE_MISSING`. It must be text (or a number or true/false, read as text), at most 256 characters |
| id | `idPointer` | `sha256:<hex>` of the raw body, so the same body is the same event |
| subject | `subjectPointer` | the id |
| scope | `scopePointer` | the type |
| time | `timePointer` | none (shown in the history only) |

An id, subject or scope longer than 200 characters, or with characters other than letters, digits
and `. _ : @ + = / -`, is kept as `sha256:<hex>` of its text, so no ledger key carries arbitrary
text and two different values never share a key.

### 3.1.1 A fixed event type

Some senders carry the type only in an unsigned header (Snyk's `X-Snyk-Event`, GitHub's
`X-GitHub-Event`) or send a single kind of event, so no signed body field holds it. An endpoint
can declare `fixedType` instead of `typePointer`: every event it accepts has that type. The
receiver never reads a header to decide the type; only the authenticated body decides, and with a
fixed type the body does not decide it at all.

- `fixedType` is 1 to 256 characters of letters, digits and `. _ : @ + = / -`. Sending it together
  with a non-empty `typePointer` is refused (`400 INVALID_EVENT_TYPE`). It is stored with
  `typePointer` `""`, which a fixed-type endpoint never resolves, so `""` does not mean "the whole
  document" there.
- Changing an endpoint from a fixed type to a pointer needs the new `typePointer` in the same
  update; setting either one clears the other.
- Without a fixed type, `typePointer` must name a field: creating or updating an endpoint with
  `typePointer` `""` and no `fixedType` is refused (`400 INVALID_EVENT_TYPE`), because `""`
  would read the whole body as the type. An endpoint stored that way earlier keeps working as it
  is until its type is next changed.
- Automations filter on the type as usual; every event matches a type pattern that matches the
  constant.
- The **scope defaults to the type**, so with a constant type every event shares one scope, and the
  cooldown (counted per scope, §5) then spaces all of the endpoint's events apart. Set
  `scopePointer` to a body field that tells sources apart (a project or repository id) to keep the
  cooldown per source.

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

**The two switches behave differently.** With the automation team's `workflow.inboundEventsEnabled`
off, the endpoint refuses the call (`409`) and nothing is recorded: a redelivery after it is switched
on is decided afresh. With the target repository team's switch off, the decision is **recorded** as
`SUPPRESSED_PRECONDITION`, so the team sees why nothing ran; a redelivery of that event then answers
`duplicate`, and once the repository's team switches it on, a manager takes it again with **Decide
again**.

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
- **Only the authenticated body decides.** Everything a decision reads — type, id, subject, scope,
  matched and mapped values — comes from the body; no request header other than the one carrying
  the signature or secret is read. Under `autoswe-v1` and `hmac-sha256` that body is signed: any
  change to it fails verification. Under `shared-secret-header` the call is authenticated by the
  secret alone, and the body is whatever its holder sent; nothing binds the two.

## 6. Recipe: Snyk to `vulnerability-remediation`

Snyk posts a `project_snapshot/v0` webhook each time it tests a monitored project. With a Snyk
event endpoint and one automation, a new open-source dependency finding starts the
[`vulnerability-remediation`](./maintenance-workflows.md#2-vulnerability-remediation) template on
the repository, which opens a draft pull request that a person merges.

**What was checked.** The signature, the headers and the payload's top-level shape come from
Snyk's public webhook documentation ("Webhooks" and "Validation and versioning of payloads", under
docs.snyk.io/snyk-api/using-specific-snyk-apis/webhooks-apis). Snyk's page shows `newIssues` only
as an empty array described as "issues matching API responses", and gives the issue object in its
separate issue example. The issue pointers below are taken from that example and are **not**
confirmed against a recorded delivery: send a test and read the first real body before trusting
them, because a pointer that misses simply leaves its input unfilled.

**What Snyk sends** (documented):

- `X-Hub-Signature: sha256=<hex>`, described as the HMAC hex digest of the request body, keyed
  with the webhook's secret. The documentation's own example re-serialises the parsed JSON, so it
  does not say the digest is over the exact bytes sent. This receiver verifies the raw bytes: if
  the first delivery answers `401`, that is the first thing to look at.
- `X-Snyk-Event` (`project_snapshot/v0`, and `ping/v0` for a test), `X-Snyk-Transport-ID`
  and `X-Snyk-Timestamp`. No header is read here (§5): the event type is the preset's constant, and
  the body has no event id, so each delivery is keyed by a digest of its body.
- A body of `project`, `org`, `group`, `newIssues[]` and `removedIssues[]`. The event fires on every
  test of an existing project, whether or not anything is new, not on import. Documented targets
  are open-source and container projects. Snyk Code and Infrastructure as Code findings are not
  delivered by this webhook.
- Documented project fields: `id`, `name`, `type` (the documented example is `maven`),
  `origin`, `remoteRepoUrl`, `branch`, `importingUser` and more. Documented issue fields (from the
  example): `id`, `issueType`, `pkgName`, `pkgVersions` (an array), `issueData.severity`,
  `issueData.identifiers` (arrays under keys such as `CVE`, `CWE` and `ALTERNATIVE`, the last
  holding the `SNYK-…` id in the example), `issueData.nearestFixedInVersion` and
  `fixInfo.nearestFixedInVersion`. The set of `project.type` values and the key under which a GHSA
  id would appear are not in the pages read.

**Steps.**

1. **Endpoint.** On the team's event-endpoint card choose the preset **Snyk project snapshot** and
   save. Keep the secret it shows once. The preset is `hmac-sha256` in `X-Hub-Signature` with
   prefix `sha256=` and `hex` encoding, a constant type `project_snapshot/v0` (§3.1.1), and
   `/project/id` as subject and scope, so the cooldown and the in-flight check count per Snyk
   project.
2. **Register the webhook** with Snyk: the endpoint's URL and the secret, through Snyk's webhooks
   API as its documentation describes. Snyk sends `ping/v0` to test; because the type is a
   constant, a ping is read as a `project_snapshot/v0` event, and the `exists` rule below is what
   keeps it from starting a run.
3. **Automation.** Create an `inbound.event` automation (§4) on the endpoint with template
   `vulnerability-remediation`, a target repository (`targetConnectionId`), event types
   `project_snapshot/v0`, and the rules and fields below.

   **Two match rules are mandatory.** Automations start with no match rules, and every advisory
   input of the template is optional, so a delivery the rules let through always starts a run:

   - `/newIssues/0` `exists`. Snyk sends a snapshot on every test of a project, new findings or
     not, and a `ping/v0` reads as a snapshot (step 2). Without this rule each of them starts a run
     with only the repository filled. The template's brief then tells the agent to change nothing,
     but the run still spends a workspace and a model call.
   - `/newIssues/0/issueType` `eq` `vuln`. A new issue can be a licence finding
     (`issueType` `license`), which no dependency bump fixes; without this rule its package name
     and versions are handed to the agent as if it were an advisory.

   | Kind | Pointer | Value |
   |---|---|---|
   | match (mandatory) | `/newIssues/0` | `exists` |
   | match (mandatory) | `/newIssues/0/issueType` | `eq` `vuln` |
   | match | `/project/id` | `eq` the Snyk project id of that repository |
   | match | `/project/type` | `in` the open-source ecosystems you use (for example `npm`, `yarn`, `pnpm`; check the value against a real delivery) |
   | field `packageName` | `/newIssues/0/pkgName` | |
   | field `vulnerableVersions` | `/newIssues/0/pkgVersions/0` | the version found in the project, not the vulnerable range (see below) |
   | field `fixedVersions` | `/newIssues/0/fixInfo/nearestFixedInVersion` | |
   | field `severity` | `/newIssues/0/issueData/severity` | |
   | field `advisoryId` | `/newIssues/0/id` | or `/newIssues/0/issueData/identifiers/CVE/0` for a CVE |

   As JSON, the two mandatory rules are
   `{ "pointer": "/newIssues/0", "op": "exists" }` and
   `{ "pointer": "/newIssues/0/issueType", "op": "eq", "value": "vuln" }`.

   Set a conservative `cooldownMinutes` and `maxRunsPerDay`. One automation covers one
   repository (§4), so a second repository needs a second automation with its own project id.

**What the recipe does not do, and why.**

- **Only the first issue is read.** A mapped field is one scalar, so `/newIssues/0` is the only
  issue acted on in a delivery. The others are not acted on, and nothing records that they were
  skipped. The `issueType` rule also reads only `/newIssues/0`, so a delivery whose first new
  issue is a licence finding is dropped whole, even when a later one is a vulnerability.
- **Match the repository by project id, not name.** `project.name` and `remoteRepoUrl` are text
  that anyone able to import or rename projects in the Snyk organisation chooses. Matching on the
  id (a UUID Snyk assigns) means the person who can monitor a project cannot steer a run to a
  different repository by naming a project after it. They can still make the sender's text
  (a package name, versions) arrive for the repository whose project they control, so those values
  stay data the run checks (§5), bounded in length and alphabet by the template.
- **Open-source dependency findings only.** A container or base-image finding needs a different fix
  (the image, not a manifest), so the `/project/type` rule filters those out. Snyk Code and
  Infrastructure as Code findings are not delivered by this webhook at all.
- **A kill switch.** While `workflow.inboundEventsEnabled` is off the endpoint answers `409` (§1).
- **Dropped deliveries stay dropped.** The body is capped at 128 KiB, and a per-address rate limit
  can refuse a burst. A project with many new issues can exceed the cap. Snyk's documentation does
  not describe retries, so assume a refused or failed delivery is not sent again.
- **Overlap with Snyk's own fix pull requests.** If Snyk's automatic fix or upgrade pull requests
  are on for the project, both may open a change for one finding. Turn one of them off for the
  project or expect a duplicate.
- **No personal data.** Do not map `importingUser` (name, username, email) or any other person's
  details into a field; the template has no input for them and the run description would carry
  them.
- **Severity must match exactly.** Snyk's severity is `low`, `medium`, `high` or `critical` in the
  documented example; the template takes those four lower-case values and anything else fails the
  start (`FAILED_TO_START`). Leave `severity` unmapped if a delivery uses another spelling.
- **An empty delivery starts nothing only because of the `exists` rule.** The engine has no
  backstop: every advisory input is optional, and nothing checks at save that an automation has
  the two mandatory rules. Without them every snapshot of the project and every `ping/v0` starts a
  run with only the repository filled, and the automation's `cooldownMinutes` and `maxRunsPerDay`
  are the only bound on how many (each spends a workspace and a model call). The template's brief
  tells the agent to change nothing when the request names no package, which limits what such a
  run does, not that it runs.
- **`vulnerableVersions` carries the installed version.** `pkgVersions` lists the versions of the
  package found in the project, so `/newIssues/0/pkgVersions/0` is one affected version, such as
  `4.17.20`, not the range the advisory covers. The documented example names no field holding the
  range; the agent works the range out from the advisory and the package's registry (its brief
  already has it check every value).

## 7. Recipe: PagerDuty to `incident-triage`

PagerDuty v3 webhook subscriptions post an event for each change to an incident. With a PagerDuty
event endpoint, a `pagerduty` connection and one automation per repository, a newly triggered
incident on a service starts the `incident-triage` template on the repository that service runs.
The run reads the incident, its alerts and its log entries, has the `incidentTriager` agent
diagnose it against a throwaway checkout, and adds the diagnosis to the incident as a note.

**What was checked.** The signature, the envelope and the incident fields come from PagerDuty's
developer documentation ("Verifying Signatures" and "V3 Webhooks Overview" for webhooks, and the
REST API reference for incidents, alerts, log entries and notes). They are not confirmed against a
recorded delivery or a live account: send a test and read the first real body before trusting
them.

**What PagerDuty sends** (documented):

- `X-PagerDuty-Signature: v1=<hex>`, an HMAC-SHA256 of the raw body keyed with the subscription's
  secret, with one signature per secret while PagerDuty rotates it (§2). PagerDuty generates the
  secret when the subscription is created: paste it as the endpoint's secret.
- A body of `event` with `id`, `event_type` (`incident.triggered`, `incident.acknowledged`,
  `incident.resolved`, …), `occurred_at` and `data`, the incident: `id`, `title`, `status`,
  `service.id` and more.

**The connection.** A `pagerduty` connection on the team holds a PagerDuty REST API key (the
connection's `apiToken`, set through `POST`/`PATCH /api/v1/repositories` and stored encrypted like
every connection token; the dashboard's connection form has no token field) and, in its config,
`fromEmail`, which is refused when it is not an email:
the email of a PagerDuty user, which PagerDuty requires on a note write and shows as the note's
author. A scoped key needs read access to incidents and `incidents.write` for notes. The worker
calls `https://api.pagerduty.com` only.

**The automation.** One `inbound.event` automation per repository, on the PagerDuty endpoint:

| Setting | Value |
|---|---|
| Template | `incident-triage` |
| Repository | the repository the service runs |
| Event types | `incident.triggered` |
| Match | `/event/data/service/id` `eq` the PagerDuty service id |
| Fields | `incidentId` from `/event/data/id` |
| Options | `pagerdutyConnectionId`: the team's `pagerduty` connection; `mode`: `triage` (the default) or `fix`; optionally `minFixConfidence` |

The connection is an option of the automation, never a field read from the event, so a forged or
forwarded body cannot choose the credential: the team's access to it is checked when the
automation is saved and again at every fire. The id is the event's, so a redelivery is a
duplicate; the subject is the incident and the scope its service, so the cooldown counts per
service.

**What the run does.**

- `triage` mode: diagnose, then post the diagnosis as a note. The diagnosis names a category
  (`code`, `configuration`, `dependency`, `infrastructure`, `external` or `unknown`), a root cause,
  the evidence checked, a suggested fix and a confidence. A reply that is not the expected JSON is
  still posted, marked unstructured.
- `fix` mode: when the diagnosis is `code`, says it is fixable, and its confidence is at least
  `minFixConfidence` (default 0.7), the implementer attempts the change with the diagnosis fenced
  as untrusted data, the quality gates run, and a **draft** pull request opens. The note links it.
  A fix that fails or changes nothing still posts the diagnosis, with the reason no fix opened.
- The note is an `internal_write`: under the default autonomy policy it posts without waiting for
  anyone. A team that wants a person to sign off requires approval for `internal_write` in its
  policy ([autonomy-policies.md](./autonomy-policies.md)); the run then waits for that approval.

## Limitations

- **Qodo is not an inbound-event sender.** Qodo emits no outbound webhooks, so there is nothing for
  an endpoint to receive; its findings are pulled by the worker after a GitHub App delivery nudges
  it ([pr-feedback.md §8](./pr-feedback.md#8-qodo-findings)).
- **`hmac-sha256` and `shared-secret-header` have no timestamp.** A captured call can be replayed
  for as long as the secret is valid. The dedupe key stops the same event id from starting a second
  run, but an event that names no id is keyed by its body, and a replay of it is a duplicate only
  while its earlier decision is kept (decisions that started nothing are pruned after the retention
  period). Prefer `autoswe-v1` where the sender can produce it.
- **One previous secret, 24 hours.** Rotating twice within a day drops the first secret at once.
- **Pointers only.** The type, id and values are read with JSON Pointers into the body (or the
  CloudEvents envelope). A sender that puts its event type or id only in a header (GitHub's
  `X-GitHub-Event` and `X-GitHub-Delivery`) cannot be read by those headers; point at a body field
  instead, or let the id fall back to the body's digest. The type alone can instead be a constant
  (§3.1.1), which cannot tell a sender's event kinds apart.
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
- **The guards are the endpoint's, not the repository's.** Same subject, cooldown, in flight and the
  decision lock are all keyed on the endpoint (`@endpoint/<id>`). An event automation that acts on a
  repository does not see runs that repository's own GitHub automations started, nor runs another
  endpoint's automations started on the same repository: each can start a run on it for the same
  problem, and only each automation's daily cap bounds them.
- **No per-sender IP allowlist,** and the rate limit is per client address, not per endpoint.
- **The receiver answers after deciding.** A sender with a short timeout may give up while a run is
  being started; sending the event again is safe, because the decision is keyed by the event.
- **The Snyk recipe reads one issue per delivery and one repository per automation (§6).** Its issue
  pointers come from Snyk's documented example, not a recorded delivery, and Snyk's payload is
  documented as able to change while the webhooks are in beta. Only `newIssues[0]` is handled: a
  delivery whose first new issue is a licence finding is dropped even when a later one is a
  vulnerability.
- **The PagerDuty recipe is checked against documentation only (§7).** The signature, envelope
  and REST calls follow PagerDuty's documentation; nothing was tested against a live PagerDuty
  account or a recorded delivery.
- **The PagerDuty recipe's rules are required, and nothing enforces them (§7).** An automation that
  selects more than `incident.triggered` starts a run for each acknowledgement, escalation and
  resolution of an incident it already triaged, bounded by its cooldown and `maxRunsPerDay`; one
  without the service id rule triages every service's incidents against its one repository.
- **A PagerDuty triage reads a bounded view.** The run reads the 25 most recent alerts and log
  entries, each alert body cut to 4,000 characters, and posts at most 25,000 characters. Notes are
  plain text: PagerDuty does not render Markdown in them.
- **The recipe's two match rules are required, and nothing enforces them (§6).** An automation
  without `/newIssues/0` `exists` and `/newIssues/0/issueType` `eq` `vuln` starts a run for every
  snapshot and ping it selects, bounded only by its cooldown and `maxRunsPerDay`. Neither the
  automation save nor the engine checks that the rules are there.
