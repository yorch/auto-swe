# Platform Pivot — P4 Epic: Distribution layer (bundles, install, coded capabilities)

> Build plan for **Phase P4** of the [platform pivot](./platform-pivot.md) (§P4). P4 makes library
> content **distributable** across deployments/parties and lets third parties add **new
> capabilities**. P0–P3 deliberately made the libraries export/import-friendly (versioned,
> name-referenced, `origin`-tagged), so this phase is **additive** — no rework of the engine.
>
> Status: 🔄 **In progress** — slicing below. WS1 is the foundation; later work-streams are gated
> on it and on scope confirmation (the marketplace / coded-capability / SDK tiers are large).

---

## Outcomes (definition of done)

- A **bundle** = a versioned, self-describing export of a *tagged set* of library entities (Agents,
  Skills, scanner patterns, Templates, Connection **types**) + a **dependency manifest** ("requires
  the `github` connector").
- **Export** any tagged set to a bundle artifact; **install** a bundle into another deployment as a
  **managed base layer** — installed entities are seeded as the base, user customizations remain
  **overrides via the P1 cascade**, so bundle upgrades and user edits coexist.
- Provenance/trust on install (first-party vs community), RBAC (platform ADMIN → GLOBAL, team OWNER
  → TEAM), and idempotent re-install/upgrade (same coherence model as `syncBuiltins`).
- **Coded** third-party capability = a **container-contract step** (Decision 16): a manifest
  (image, I/O schema, resource limits, required connections, egress allowlist) executed via
  `ephemeralContainer.ts` with JSON stdin→stdout. Untrusted code never enters the worker process.
- An **authoring SDK** (`packages/sdk/`) to define bundles/Agents/Templates/coded steps in TS with a
  local test harness.

## Non-goals (this phase)

- A hosted public marketplace / billing. WS3 ships install-from-source + a trust model; a storefront
  UI is minimal.
- Cryptographic key management infrastructure (KMS, rotation). WS3 starts with detached signatures +
  a pinned trusted-key list; full key lifecycle is later.

## Open questions → resolutions (defaults; revisit per slice)

| Question | Resolution for this phase |
|---|---|
| Bundle artifact format | A single versioned JSON document (`bundleSchemaVersion`) with a `metadata` block, an `entities` map per library type, and a `dependencies[]` manifest. Self-describing; diff-friendly; round-trips through the existing Zod schemas. |
| Signing / trust | Start with a content **sha256** over the canonicalized entity payload + `source`/`origin` metadata; **detached signature + pinned trusted-key allowlist** added in WS3. No KMS yet. |
| Coded-step transport | **stdin → stdout JSON** over `ephemeralContainer.ts` first (sidecar/streaming deferred). Reuses the Phase-6 shell-container isolation (`--network=none` + egress allowlist). |
| Cross-process cache invalidation on install | TTL-only today (same limitation as scanner/pattern edits); documented. A cross-process invalidation bus is out of scope. |
| Secret scoping for capability connections | A coded step declares **required connection types**; install/run binds team-scoped `Connection` rows via the existing resolver — no secrets travel in the bundle. |

---

## Workstreams

### WS1 — Bundle format + export (read-only foundation)
**Why:** everything else consumes the bundle artifact; export is read-only and low-risk.

- **Shared:** `BundleManifest` Zod schema + types (`packages/shared/src/bundle/`): `bundleSchemaVersion`,
  `metadata` (name, version, description, source, createdAt, contentHash), `entities`
  (`agents`, `skills`, `scannerPatterns`, `templates`, `connectionTypes`), `dependencies[]`
  (connector/type requirements). A `computeContentHash(bundle)` helper (stable stringify → sha256).
- **Gateway:** `bundleService.exportBundle(prisma, selector)` — selector = `{ origin?, ids?, scope? }`
  → reads the matching library rows, strips deployment-local fields (ids, timestamps, credential
  ciphertext, team bindings), emits a `BundleManifest`. Admin route `POST /api/v1/admin/bundles/export`.
- **CLI:** `auto-swe bundles export --origin swe-starter -o swe.bundle.json`.
- **Acceptance:** exporting the seeded `swe-starter` set yields a manifest that validates against the
  schema and contains the SWE Agents/Skills/scanner patterns/templates; secrets/local ids excluded.

### WS2 — Install / upgrade as a managed base layer
**Why:** the consume side; makes bundles useful across deployments.

- **Gateway:** `bundleService.installBundle(prisma, manifest, { scope, teamId })` — validates schema +
  content hash, checks the dependency manifest (required connector types exist), then **idempotently
  seeds** each entity (findFirst+create / version-bump, mirroring `syncBuiltins`) tagged with the
  bundle's `origin`/`source` as the **managed base layer**. User overrides (P1 cascade) sit on top and
  are never clobbered; re-install = upgrade. Admin route `POST /api/v1/admin/bundles/install`; RBAC
  (ADMIN → GLOBAL, team OWNER → TEAM).
- **CLI:** `auto-swe bundles install swe.bundle.json [--team <slug>]`.
- **Acceptance:** install into an empty deployment seeds the entities; editing one then re-installing a
  newer bundle upgrades the base layer while preserving the user override; missing dependency → clear,
  non-destructive error.

### WS3 — Provenance, trust, transport (marketplace-lite)
**Why:** safe install of content you didn't author.

- A `Bundle` registry table (installed bundles + version + source + trust state); detached signature
  verification against a pinned trusted-key allowlist; install-from-URL. Minimal admin UI (list
  installed bundles, install from file/URL, show provenance).
- **Acceptance:** a tampered bundle (hash/signature mismatch) is rejected; first-party vs community is
  surfaced; only authorized roles can install.

### WS4 — Coded capability = container-contract step
**Why:** the one case a bundle ships code — a new connector/mechanism core lacks.

- New `containerStep` spec node + step type: manifest (image, inputSchema/outputSchema, resource
  limits, required connection types, egress allowlist) executed via `ephemeralContainer.ts`
  (JSON stdin→stdout, `--network=none` + egress allowlist, image allowlist + audit like Phase-6
  shell). Untrusted code stays out of the worker process.
- **Acceptance:** a sample container-contract step runs in the interpreter, receives mapped inputs as
  JSON, returns JSON bound at `nodes.<id>.output`, and is governed by the existing shell-authoring RBAC.

### WS5 — Authoring SDK (`packages/sdk/`)
**Why:** the third authoring surface — define bundles/entities/coded steps in TS, test locally.

- TS helpers to declare Agents/Templates/Skills/container-contract steps + assemble a bundle, with a
  local test harness (validate against schemas, dry-run install against a scratch DB).
- **Acceptance:** the SWE starter set can be expressed via the SDK and exported to an equivalent bundle.

## PR slicing

| PR | Workstream | Risk | Notes |
| --- | --- | --- | --- |
| 1 | WS1 | Low | Bundle schema + export (read-only). Foundation. |
| 2 | WS2 | Med | Install/upgrade as managed base layer (write path; idempotent seed). |
| 3 | WS3 | High | Trust/signing + registry + transport (security surface). |
| 4 | WS4 | High | Container-contract coded steps (untrusted-code isolation). |
| 5 | WS5 | Med | Authoring SDK + test harness. |

## Risks & gotchas

1. **Don't let a bundle carry secrets.** Export strips credential ciphertext + team bindings; coded
   steps declare *required connection types* and bind local `Connection` rows at run time.
2. **Idempotent upgrade, not clobber.** Install seeds a managed base layer; the P1 cascade keeps user
   overrides on top. Re-install must converge (same row-coherence model as `syncBuiltins`).
3. **Untrusted code isolation.** Coded steps run only as container-contract steps (Decision 16),
   never imported into the worker — reuse the Phase-6 ephemeral-container sandbox + egress allowlist.
4. **V8 isolate.** Any new node type (WS4) is a static step-registry entry; the run is an activity.

## Sequencing checklist

**Status: 🔄 in progress (WS1 + WS2 done — content distribution end-to-end via the API).**

- [x] WS1 — bundle format + export: `BundleManifest` Zod schema + `computeContentHash` +
  `parseBundle` (`@auto-swe/shared/bundle`); `bundleService.exportBundle` (GLOBAL content, locals
  stripped, deps derived); admin route `POST /api/v1/admin/bundles/export`.
- [x] WS2 — install / upgrade (managed base layer): `bundleService.installBundle` (schema + content-
  hash + dependency checks before any write; idempotent GLOBAL seed of skills → patterns → agents
  (+skill refs) → templates, provenance-tagged); admin route `POST /api/v1/admin/bundles/install`.
- [ ] WS3 — provenance / trust / transport (detached signatures, registry, install-from-URL)
- [ ] WS4 — container-contract coded steps
- [ ] WS5 — authoring SDK

> Follow-up (thin): `auto-swe bundles export/install` CLI subcommands over the new API (the gateway
> API + a web surface are the primary paths; the CLI is a convenience wrapper).
