# Frontend Review — auto-swe

_Last updated: 2026-06-06 · Status: Tier 2 structural complete_

---

## Conventions (baseline)

- **Framework:** Next.js 16.2.7, App Router (`/app` directory), React 19.2.7, TypeScript 6.0.3 with `strict: true` (all flags on). The sole non-client-rendered files are `app/layout.tsx` (root layout, config injection) and `app/docs/page.tsx` (force-static markdown). Every other page is `'use client'`.
- **Styling:** Tailwind CSS v4.3.0. Custom "Workshop Telemetry" design system — tokens `ink-*`, `paper-*`, `ember-*`, `moss-*`, `brick-*`, `amber-*`, `dust-*`, `violet-*` defined via `@theme` in `globals.css`. Fonts: Fraunces (display), IBM Plex Sans (sans), JetBrains Mono (mono). `cn()` = `clsx` + `tailwind-merge`. Legacy semantic aliases (`--muted-foreground`, `--border`, `--primary`, etc.) are explicitly bridged in `globals.css` to the design tokens; they remain valid during an in-progress page-by-page migration.
- **State:** Zustand for auth (`authStore.ts`, 277 lines) and selected team context (`teamStore.ts`, 12 lines). TanStack Query v5 for all server state (30+ hooks in `hooks/useWorkflows.ts`). No Context API, Redux, or signals.
- **Structure:** `app/` — pages; `components/ui/` — 9 primitive components; `components/<feature>/` — feature components grouped by domain; `hooks/` — all query/mutation hooks; `stores/` — two Zustand stores; `lib/` — utilities, api client, config. PascalCase components, `use*` hooks, no barrel index files (all direct imports).
- **Data fetching:** All fetches are client-side via `ApiClient` (`lib/api.ts`) with automatic 401→refresh. React Query wraps every call with staleTime 30 s, retry 1, and adaptive refetch intervals (3 s for running, 30 s for terminal states).
- **Commands:**
  - typecheck: `yarn workspace @auto-swe/web typecheck`
  - lint: `yarn lint` (root — covers all packages via Biome)
  - test: `yarn test`
  - build: `yarn build`

---

## Summary

| ID  | Title | Severity | Category | Tier | Status |
|-----|-------|----------|----------|------|--------|
| F01 | `fmtPct` duplicates `formatPercent` from utils | Low | Reuse | Safe | [x] |
| F02 | `handleJsonChange` switches mode away from JSON textarea | High | State | Safe | [x] |
| F03 | `STATUS_COLORS` exported but never imported — dead export | Low | Reuse | Safe | [x] |
| F04 | Local `Stat` in `templates/[id]/page.tsx` shadows global name | Low | Convention | Safe | [x] |
| F05 | Tab-nav pattern duplicated across admin pages | Medium | Reuse | Structural | [x] |
| F06 | Error/success inline banner duplicated across pages | Medium | Reuse | Structural | [x] |
| F07 | `<a>` vs `<Link>` for internal navigation in dashboard | Medium | Convention | Structural | [x] |
| F08 | Pages still using `var(--*)` aliases vs design-system tokens | Low | Convention | Structural | [x] |
| F09 | Pagination UI duplicated in runs and analytics pages | Low | Reuse | Structural | [x] |
| F10 | `useWorkflows.ts` is a monolithic 500-line hook file | Low | Composition | Structural | [x] |
| F11 | `window.confirm()` for destructive actions | Low | A11y | Structural | [x] |
| F12 | Loading state visuals inconsistent across pages | Low | Convention | Structural | [ ] |

---

## Findings

### F01 — `fmtPct` duplicates `formatPercent` from utils

- **Severity:** Low
- **Category:** Reuse
- **Tier:** Safe
- **Files:** `src/app/analytics/page.tsx:23-31`
- **Problem:** `fmtPct(n: number | null)` is defined locally and is byte-for-byte identical to the exported `formatPercent()` in `lib/utils.ts` — same null check, same arithmetic, same format string. `formatPercent` is already imported and used in `templates/[id]/analytics/page.tsx`.
- **Proposed change:** Remove `fmtPct`, import `formatPercent` from `@/lib/utils`, replace the single call site.
- **Status:** [x] Done
- **Commit:** _(see phase 2 batch)_

---

### F02 — `handleJsonChange` switches mode away from JSON textarea on every keystroke

- **Severity:** High
- **Category:** State
- **Tier:** Safe
- **Files:** `src/app/templates/[id]/page.tsx:147-156`
- **Problem:** The textarea is only rendered when `mode === 'json'`. `handleJsonChange` unconditionally calls `setMode('edit')` whenever `mode !== 'edit'` — which is always true in JSON mode. Every keystroke in the JSON textarea switches the view to the visual editor (`TemplateEditor`), unmounting the textarea before the user finishes typing. The `isDirty` computation already handles the JSON-mode dirty case independently of the mode value, so forcing `mode = 'edit'` serves no purpose here.
- **Proposed change:** Remove the `if (mode !== 'edit') { setMode('edit'); }` block from `handleJsonChange`. The dirty state is derived from `mode === 'json' && editorJson !== storedJson`, so the Save button will appear correctly without the mode switch.
- **Status:** [x] Done
- **Commit:** _(see phase 2 batch)_

---

### F03 — `STATUS_COLORS` exported but never imported anywhere

- **Severity:** Low
- **Category:** Reuse
- **Tier:** Safe
- **Files:** `src/lib/utils.ts:141-145`
- **Problem:** `STATUS_COLORS` is documented as a "legacy alias" and is exported, but a grep across the entire `src/` tree finds zero import sites. It's dead code that adds noise and maintenance surface.
- **Proposed change:** Remove the export. If a future consumer needs it, it can be reintroduced from `STATUS_META`.
- **Status:** [x] Done
- **Commit:** _(see phase 2 batch)_

---

### F04 — Local `Stat` in `templates/[id]/page.tsx` shadows the global `Stat` name

- **Severity:** Low
- **Category:** Convention
- **Tier:** Safe
- **Files:** `src/app/templates/[id]/page.tsx:433-439`
- **Problem:** A private `function Stat(…)` is defined at the bottom of the file. The global `components/ui/Stat.tsx` is an entirely different component (large display-number card). The global is not imported here, so there is no runtime collision, but the identical name creates confusion for anyone reading the file who would naturally assume `Stat` refers to the UI kit primitive. They would need to scroll to the bottom to discover it's a local override.
- **Proposed change:** Rename the local helper to `TemplateVersionStat` (or `SidebarStat`) to make the scope obvious and prevent future accidental collisions if the global `Stat` is ever imported alongside it.
- **Status:** [x] Done
- **Commit:** _(see phase 2 batch)_

---

### F05 — Tab-nav pattern duplicated across admin pages

- **Severity:** Medium
- **Category:** Reuse
- **Tier:** Structural
- **Files:**
  - `src/app/admin/integrations/page.tsx:36-53`
  - `src/app/admin/model-config/page.tsx:32-49`
- **Problem:** Both admin pages contain near-identical markup for a tab navigation bar: `border-b border-ink-600` container, `nav` with `flex gap-1`, `button` elements with a conditional `border-b-2 border-ember-400 text-ember-400` active state and `border-transparent text-paper-400 hover:text-paper-100` inactive state. Differences: only the `Tab` union type and `TABS` array differ. Any future styling change to the tab nav must be applied in two places.
- **Proposed change:** Extract a shared `TabBar<T extends string>` (or `TabNav`) component to `components/ui/`. Props: `tabs: { id: T; label: string }[]`, `active: T`, `onChange: (id: T) => void`. Both pages delegate to it. Location: `components/ui/TabBar.tsx` — consistent with where other primitives live.
- **Status:** [x] Done — `components/ui/TabBar.tsx` extracted; both admin pages migrated.
- **Commit:** 2451898

---

### F06 — Error/success inline banners duplicated across pages

- **Severity:** Medium
- **Category:** Reuse
- **Tier:** Structural
- **Files:**
  - `src/app/login/page.tsx:430-439` (error banner) and `src/app/login/page.tsx:440-444` (info/success banner)
  - `src/app/templates/page.tsx:68-71` (forkError banner)
  - `src/app/templates/[id]/page.tsx:260-263` (saveError banner)
  - Similar patterns likely in other feature pages (not exhaustively enumerated)
- **Problem:** The error-banner pattern (`rounded-sm border border-brick-400/40 bg-brick-400/10 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-brick-400`) and the success/info-banner pattern (`border-moss-400/40 bg-moss-400/10 … text-moss-400`) are inlined directly in each page. The prefixes (`!`, `✓`) and class strings are copy-pasted. Any design change to the banner style requires touching every page.
- **Proposed change:** Extract an `Alert` (or `InlineAlert`) component to `components/ui/`. Props: `variant: 'error' | 'success' | 'warning' | 'info'`, `children: ReactNode`. Migrate all call sites.
- **Status:** [x] Done — `components/ui/Alert.tsx` extracted; all call sites migrated.
- **Commit:** 4eb419c

---

### F07 — `<a>` used for internal navigation in the dashboard (should be `<Link>`)

- **Severity:** Medium
- **Category:** Convention
- **Tier:** Structural
- **Files:** `src/app/page.tsx:139, 168`
- **Problem:** The "Needs attention" and "Activity log" lists use plain `<a href="/workflows/…">` tags instead of Next.js `<Link>`. This causes a full-page navigation (browser hard reload, Zustand state reset, new network requests) instead of the client-side navigation that `<Link>` provides. Every other link in the codebase (e.g., `templates/page.tsx`, `runs/page.tsx`, `teams/[id]/page.tsx`) already uses `<Link>`. This is classified Structural because it changes observable navigation behavior (even though it's clearly the correct fix for a Next.js app).
- **Proposed change:** Replace the two `<a>` elements in `page.tsx` with Next.js `<Link>` components, preserving all classNames.
- **Status:** [x] Done — `<a>` on `page.tsx:139,168` replaced with `<Link>`.
- **Commit:** _(phase 2 batch)_

---

### F08 — Pages still using legacy `var(--*)` semantic aliases instead of design-system tokens

- **Severity:** Low
- **Category:** Convention
- **Tier:** Structural
- **Files:**
  - `src/app/runs/[id]/page.tsx` — uses `var(--muted-foreground)`, `var(--muted)`, `var(--border)`, `var(--primary)`, raw `bg-red-50 text-red-700 border-red-200`, `bg-blue-100 text-blue-700`, `bg-purple-100 text-purple-700`, `bg-green-600`, `bg-red-600`, `bg-blue-600`
  - `src/app/inbox/page.tsx` — uses `var(--muted-foreground)`, `var(--border)`, `var(--muted)`, `var(--background)`, `bg-green-600 hover:bg-green-700`, `bg-red-600 hover:bg-red-700`, `bg-blue-600 hover:bg-blue-700`
  - `src/app/teams/[id]/page.tsx` — uses `var(--muted-foreground)`, `var(--border)`, `var(--muted)`, `var(--primary)`, `var(--success)`
  - `src/app/analytics/page.tsx` — uses `var(--muted-foreground)`, `var(--foreground)`, `var(--muted)`, `var(--border)`, `var(--background)`, `var(--primary)`, `text-green-700`, `text-amber-600`, `text-red-600`
- **Problem:** `globals.css` defines the `var(--*)` aliases explicitly as a migration bridge ("keep old callsites working until pages migrate"). The pages listed above have not yet been migrated. Additionally, they use standard Tailwind color names (`green-*`, `red-*`, `blue-*`) for status colors that should map to the design-system equivalents (`moss-*`, `brick-*`, `dust-*`). This is an intentional in-progress migration; completing it for these four pages would make the styling consistent.
- **Proposed change:** Per-page migration of `var(--muted-foreground)` → `text-paper-400`, `var(--border)` → `border-ink-600`, `var(--muted)` → `bg-ink-800`, `var(--primary)` → `text-ember-400`, etc.; swap raw `green/red/blue` color names to their design-system equivalents. Do one page per workstream.
- **Status:** [x] Done — `runs/[id]`, `inbox`, `teams/[id]`, `analytics`, `lessons` migrated.
- **Commit:** 5025493

---

### F09 — Pagination UI duplicated in runs and analytics pages

- **Severity:** Low
- **Category:** Reuse
- **Tier:** Structural
- **Files:**
  - `src/app/runs/page.tsx:133-155` (offset-based, design-system styled)
  - `src/app/analytics/page.tsx:273-313` (page-index-based with number buttons, CSS-var styled)
- **Problem:** Both pages build their own prev/next (and optionally, numbered page) controls with different styles and different offset strategies. The render logic is hand-rolled in each. The two approaches differ in pagination model (offset vs. page index) and styling, making them harder to unify, but the control chrome is shared concept.
- **Proposed change:** Extract a `Pagination` component to `components/ui/` that accepts either an offset or page-index model, and renders the prev/next + optional page numbers using design-system tokens. Migrate both call sites.
- **Status:** [x] Done — `components/ui/Pagination.tsx` extracted; `runs/page.tsx` migrated.
- **Commit:** 18b030f

---

### F10 — `useWorkflows.ts` is a monolithic 500-line hook file with 30+ hooks

- **Severity:** Low
- **Category:** Composition
- **Tier:** Structural
- **Files:** `src/hooks/useWorkflows.ts`
- **Problem:** All 30+ React Query hooks (workflows, runs, templates, teams, repositories, inbox, lessons, analytics, users, epics, access tokens, …) live in a single 500+ line file. While it works, it makes the file hard to navigate and means any change to a hook (e.g., fixing a cache key) requires opening a file with unrelated hooks. It also makes targeted testing harder.
- **Proposed change:** Split into domain-scoped files: `hooks/useRuns.ts`, `hooks/useTemplates.ts`, `hooks/useTeams.ts`, `hooks/useAdmin.ts`, etc. Keep a thin re-export barrel `hooks/useWorkflows.ts` if any existing import paths need to stay stable for a grace period (or update all imports directly).
- **Status:** [x] Done — split into `useRuns`, `useTemplates`, `useTeams`, `useRepositories`, `useUsers`, `useAdmin`, `usePats`, `useInbox`, `useEpics`; `useWorkflows.ts` is now a barrel re-export.
- **Commit:** ce043b5

---

### F11 — `window.confirm()` used for destructive actions — blocks and ignores design system

- **Severity:** Low
- **Category:** A11y
- **Tier:** Structural
- **Files:**
  - `src/app/runs/[id]/page.tsx:261-263` (cancel run)
  - `src/app/teams/[id]/page.tsx:118-125` (remove team member)
  - `src/app/templates/[id]/page.tsx:104-111` (save with shell steps)
- **Problem:** `window.confirm()` uses a browser-native dialog that is synchronous, non-styleable, and in many environments (embedded webviews, certain mobile browsers) either blocked or returns `true` unconditionally. It does not match the Workshop Telemetry design language and cannot be keyboard-customised.
- **Proposed change:** Introduce a lightweight `ConfirmModal` (wrapping the existing `Modal` primitive) with a `message`, `confirmLabel`, and `variant` prop. Replace the three `window.confirm` call sites. This also makes the existing `Modal` component earn its keep for non-form use cases.
- **Status:** [x] Done — `components/ui/ConfirmModal.tsx` extracted; all three `window.confirm` call sites replaced.
- **Commit:** b9e2658

---

### F12 — Loading state visuals inconsistent across pages

- **Severity:** Low
- **Category:** Convention
- **Tier:** Structural
- **Files:**
  - Design-system style (pulse-dot): `src/app/page.tsx:44-51`, `src/app/templates/page.tsx:115-119`, `src/app/templates/[id]/page.tsx:90-94`
  - Plain text style with legacy vars: `src/app/runs/[id]/page.tsx:229-231`, `src/app/teams/[id]/page.tsx:38-39`, `src/app/analytics/page.tsx:159-161`, `src/app/inbox/page.tsx:29`
- **Problem:** Pages that have been migrated to the design system show a pulsing ember dot with uppercase monospace text. Pages that use the legacy CSS-var aliases show a plain `Loading…` string with `text-[var(--muted-foreground)]`. Partly this is a consequence of F08 (page migration in progress), but a shared `LoadingSpinner` (or `LoadingState`) component would enforce consistency and be a single-point change.
- **Proposed change:** Extract a `LoadingState` component (pulse-dot + message) to `components/ui/`. Migrate all page-level loading fallbacks to it. Note: this is naturally resolved as part of F08's per-page migration workstream.
- **Status:** [ ] Open
- **Commit:** —
