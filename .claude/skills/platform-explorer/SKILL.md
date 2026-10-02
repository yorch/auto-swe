---
name: platform-explorer
description: Maintain the public interactive platform explorer as code changes. Use when refreshing capabilities, architecture, use cases, concepts, models, features, or limitations; resolving its narrative-review warning; or changing its source extraction and GitHub Pages publication.
---

# Maintain the code-grounded platform explorer

The explorer is served at `https://yorch.github.io/auto-swe/platform-explorer/`.
It is a self-contained HTML explanation of implementation, not a live platform dashboard.
Use **source code, not documentation, as capability evidence**. Reading this skill, repository
instructions, and build configuration is fine; copying claims from `docs/`, README files, or
frozen plans into the analysis is not.

## Files and ownership

Paths below are relative to the repository root. If a tool starts in this skill directory,
resolve them against `../../..`, not against the skill directory itself.

| File | Owns |
|---|---|
| `site/src/explorer/analysis.json` | Reviewed feature/concept/use-case/limitation cards, model descriptions and groups, evidence locators, review commit, and code fingerprints |
| `site/src/explorer/platform-explorer.html` | HTML/CSS/JS shell; architecture, lifecycle, node explanations, and other inline narrative; nine interactive views |
| `site/scripts/platformExplorer.mjs` | Code-derived inventories, anchored excerpts, drift detection, and safe snapshot serialization |
| `site/scripts/reviewPlatformExplorer.mjs` | Explicit manual review attestation; never part of sync/build or CI |
| `site/scripts/platformExplorer.test.mjs` | Extractor, evidence, graph, publication-link, interaction, escaping, and drift tests |
| `site/scripts/verifyPlatformExplorer.mjs` | Post-build check of rendered home/sidebar links and the generated snapshot URL |
| `site/scripts/manifest.mjs` | Explorer route and label; GitHub Pages base path |
| `site/scripts/syncDocs.mjs` | Generates explorer HTML during the existing site sync |
| `site/astro.config.mjs`, `site/src/components/Landing.astro` | Sidebar and home-page discovery |
| `.github/workflows/pages.yml` | Deployment triggers, including package-code changes |

**Do not edit or commit** `site/public/platform-explorer/index.html` or
`site/dist/platform-explorer/index.html`. Both are generated, gitignored output. Do not depend on
an old `analysis/platform-explorer.html`, `/tmp` scripts, or a hand-copied snapshot.

## What updates automatically — and what does not

Every `yarn workspace @auto-swe/site sync` (also run by dev/build) reads the checked-out code:

- Prisma models, fields, relation targets, mappings, and schema index declarations;
- built-in templates, validated specs, and edges derived with the shared `nodeEdges` helper;
- node types, registered steps, registry settings, literal agent seed metadata, and package dependencies;
- mounted route families and recognized literal HTTP declarations;
- source excerpts resolved from **unique text anchors**, with fresh line numbers;
- source commit, build time, and code-change warnings.

The build does **not** understand whether a capability's explanation is still true. It compares
code fingerprints with the reviewed baseline and displays **Narrative review needed** if code
changed. This covers added, removed, and modified package code as well as the app compose file,
not just the files cited in cards. The check is conservative: a test-only change can raise the
warning. A fingerprint match is not proof of behavior, deployment readiness, or security.

Counts can be fresh while prose is stale. Never clear the warning just to make the page look
current. The reviewed commit and generated source commit deliberately have different meanings.

## Refresh procedure

1. **Inspect the change set and provenance.** Use the recorded `reviewedCommit` in `analysis.json`:
   ```sh
   git status --short
   git diff <reviewedCommit>...HEAD -- packages docker-compose.app.yml
   yarn workspace @auto-swe/site sync
   ```
   Review local uncommitted changes too. Missing review history in a shallow clone is a reason to
   obtain history, not to skip the review. Build/drift detection itself works in shallow clones.

2. **Read affected implementations and callers.** Follow control flow and side effects, not only
   names, interfaces, comments, or registry descriptions. Source starting points:
   - `packages/shared/src/workflow/{spec,interpreter,stepRegistry,builtinTemplates}.ts` and `templates/`;
   - `packages/shared/src/prisma/schema.prisma`, plus existing migrations when making DDL claims;
   - `packages/shared/src/config/registry.ts` and `lib/syncBuiltins.ts`;
   - gateway boot, route handlers, auth/RBAC, and launch/run services;
   - worker workflows, activities, agent execution, credential/config resolution, connectors,
     scanners, workspace/container boundaries, accounting, tracing, evaluation, and memory;
   - web/CLI/SDK entry points for claims about those user-facing surfaces.
   Do not run Prisma migrations or edit Dockerfiles merely to refresh this analysis.

3. **Update the reviewed narrative in both authored files.** Add/remove affected cards, caveats,
   model descriptions/groups, lifecycle text, component explanations, and node descriptions.
   Maintain the distinction between implemented handlers, seeded library content, inferred uses,
   placeholders, and known limitations. A template that waits for a deployment signal is not a
   deployment implementation. An approval check in one writer is not a universal external-write
   boundary. Verify ordering, retries/idempotency, selective version pinning, budgets, and isolation
   before changing those claims. Do not add hard-coded inventory counts to narrative or tests.

4. **Maintain evidence.** Each analytical card's `refs` must name existing source IDs. A locator
   supplies `path`, unique `anchor`, optional `before`, and excerpt `lines`. Choose an executable
   declaration/control-flow anchor with enough context to substantiate the claim, not a drifting
   absolute line number or an import alone. Missing/ambiguous anchors and invalid references fail
   generation intentionally. Review a renamed/deleted implementation, then replace or remove its
   evidence; do not loosen the uniqueness check. Excerpts are allowlisted source files, never
   credentials, local `.env` files, or documentation.

5. **Check extractor boundaries.** Prisma and seed/route metadata have static text extractors,
   not a universal compiler or runtime API enumerator. If declaration syntax changes, add a
   regression fixture and adapt the extractor. Do not accept an incomplete catalog. Route inventory
   explicitly omits unrecognized dynamic/object-form handlers; do not present it as OpenAPI.
   New models default to `Unclassified` until reviewed. New node types need a reviewed explanation
   in the shell. New templates also need the independent site use-case entry required by the
   existing use-case generator.

6. **Attest only after the review.** Platform code must be committed first; the helper refuses
   modified/untracked package code so the attestation names a real revision. Authored explorer
   changes may remain uncommitted while recording:
   ```sh
   yarn workspace @auto-swe/site explorer:review "$(git rev-parse HEAD)"
   ```
   This updates `reviewedCommit`, evidence hashes, and package-code hashes after validating the
   locators and structural data. It is a **manual attestation**, not an automated review. Re-run it
   only when the analysis has actually been checked against that revision. Commit/push the explorer
   maintenance as its own logical change, according to the repository's Git conventions.

7. **Validate and inspect the generated page**, using the checks below. Never commit generated
   output. GitHub Pages publishes on a qualifying `main` push or manual workflow dispatch; pushing
   a feature branch alone does not update the public site. Do not merge automatically.

## Validation

Use the project's Node and Yarn versions and installed dependencies. From the repository root:

```sh
yarn workspace @auto-swe/site sync
yarn vitest run site/scripts
yarn workspace @auto-swe/site build
yarn docs:check
yarn invariants:check
# Apply format fixes separately, then verify with the non-writing command:
yarn biome check site/scripts/platformExplorer.mjs site/scripts/reviewPlatformExplorer.mjs \
  site/scripts/platformExplorer.test.mjs site/scripts/verifyPlatformExplorer.mjs \
  site/src/explorer site/scripts/manifest.mjs \
  site/scripts/syncDocs.mjs site/package.json site/astro.config.mjs
git diff --check
```

Follow the repository-wide lint guidance in `AGENTS.md` before committing. In a worktree under
`.claude/`, `yarn lint` may process zero files; use the explicit root-directory check documented
there and verify the reported file count. Existing Biome configuration may exclude Astro files;
the production site build validates those integrations.

Preview the built site with `yarn workspace @auto-swe/site preview`, then visit
`http://localhost:4321/auto-swe/platform-explorer/`. Check desktop and mobile widths, all nine
views, search/filtering, relationship navigation, graph inspection and keyboard activation,
edge traversal/reset, evidence dialogs, theme, and the docs return link. Check the sidebar and
landing-page entry, not only a direct URL. Confirm `site/dist/platform-explorer/index.html` exists.

The build's publication check reads the final HTML, because Starlight automatically prefixes
`BASE` for manual sidebar links. Its sidebar receives `/<slug>/`, while the landing page uses
`siteUrl(slug)` with the base included. Passing a based URL to Starlight produces a double prefix.

The HTML requires no CDN, fonts, platform services, fetch calls, credentials, or backend. Network
access is only user-followed links. Use `template.content.textContent` to read the inert JSON
snapshot and retain safe serialization of markup and template-like strings. Do not replace the
inert container with an executable script or introduce remote assets for convenience.

Local source previews can include uncommitted code; the page marks them and labels GitHub links
as committed code before those edits. A clean CI checkout produces commit-pinned public source
links. Never describe a local preview, static review, or successful site build as a production
platform/security/integration test.
