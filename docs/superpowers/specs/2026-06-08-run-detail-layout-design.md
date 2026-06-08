# Run Detail Layout: Steps + Traces UX Redesign

**Date:** 2026-06-08  
**Status:** Approved for implementation

## Problem

The run detail page has three separate tabs — Traces, Steps, Security. Clicking a step in the Steps tab silently switches to the Traces tab with a filter applied. The tab switch is invisible; there is no feedback that clicking caused a navigation, and the connection between "I clicked a step" and "these are its traces" is not obvious.

## Solution

Two switchable layouts for the bottom panel on the run detail page, controlled by a persistent user preference stored in the DB:

- **Split panel** (default): steps list on the left, traces panel on the right — always visible together, no tab switching.
- **Inline expansion**: keeps the existing tabs; clicking a step expands its traces inline as an accordion below the row.

A small icon toggle in the panel header switches between layouts. The preference is saved via `PATCH /api/v1/me/preferences` and persists across devices.

---

## Section 1 — Schema & API

### Prisma

Add a `preferences` JSON column to the `User` model:

```prisma
model User {
  // existing fields ...
  preferences  Json  @default("{}")
}
```

One migration required. The relevant key within the JSON is:

```ts
runDetailLayout: 'split' | 'inline'  // default 'split' when absent
```

### Gateway endpoints

**`GET /api/v1/me/preferences`**  
Returns the authenticated user's `preferences` JSON object.  
Auth: bearer token required. Response: `200 { preferences: Record<string, unknown> }`.

**`PATCH /api/v1/me/preferences`**  
Partial merge update. Zod schema whitelists accepted keys (`runDetailLayout`); unknown keys are stripped, not rejected. Merges with the existing preferences object.  
Auth: bearer token required. Response: `200 { preferences: Record<string, unknown> }`.  
Both endpoints return `401` when unauthenticated.

### Failure handling

Preference saves are not critical. On PATCH failure the optimistic in-memory state is retained for the session without surfacing an error toast. The preference will revert to DB state on next page load.

---

## Section 2 — Components

### `useUserPreferences` hook
**File:** `packages/web/src/hooks/useUserPreferences.ts`

Wraps TanStack Query. `useQuery` fetches `GET /api/v1/me/preferences`. A `useMutation` calls `PATCH /api/v1/me/preferences` with optimistic update (revert on error). Public interface:

```ts
const { layout, setLayout } = useUserPreferences()
// layout: 'split' | 'inline'
// setLayout: (v: 'split' | 'inline') => void  — fires optimistic update + mutation
```

### `LayoutToggle` component
**File:** `packages/web/src/components/LayoutToggle.tsx`

Two icon buttons (⊞ split / ☰ inline) styled as a pill toggle. Sits at the trailing edge of the panel header in both layouts.

```ts
<LayoutToggle value={layout} onChange={setLayout} />
```

### `SplitRunPanel` component
**File:** `packages/web/src/app/runs/[id]/SplitRunPanel.tsx`

Renders the left/right split layout:

- **Left column (38% width):** steps list extracted from the current `StepsTab`. Clicking a row sets `selectedNodeId` — no tab switch. Selected row highlighted with ember accent.
- **Right column (62% width):** existing `TracesTab` component reused as-is, with `filterNodeId={selectedNodeId}`. When `selectedNodeId` is null, shows all traces (same as current Traces tab content). The filter banner's `onClearFilter` clears `selectedNodeId`.
- **Security** becomes a second top-level tab alongside the split view (tab bar: `Run | Security`).
- The DAG `onSelect` handler sets `selectedNodeId`, highlighting the matching step in the left column.

### `StepsTab` refactor (inline mode)
**File:** existing component in `packages/web/src/app/runs/[id]/page.tsx`

Gains `expandedNodeId: string | null` and `onToggleExpand: (nodeId: string) => void` props. Each step row renders an expand/collapse chevron. Clicking the row calls `onToggleExpand` — the parent manages accordion state (only one step open at a time). When a step is expanded, a `TracesPanel` sub-section renders inline below the row, reusing `TracesTab` content without the tab chrome (filter banner hidden since it's already scoped to the step). The existing Traces tab is preserved alongside Steps and Security for a flat searchable view of all events.

### `RunDetailPage` wiring
**File:** `packages/web/src/app/runs/[id]/page.tsx`

```ts
const { layout, setLayout } = useUserPreferences()
const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null)

// DAG click: works in both modes
const handleNodeClick = (nodeId: string | null) => {
  setSelectedNodeId(nodeId)
  if (layout === 'inline') {
    setExpandedNodeId(nodeId)
    setActiveTab('steps')   // switch to Steps tab so expansion is visible
  }
}
```

The bottom panel renders based on `layout`:
- `'split'` → `<SplitRunPanel>` + Security tab; the old `useEffect` that switched to Traces on node click is removed.
- `'inline'` → existing three-tab panel with refactored `StepsTab`.

The `LayoutToggle` is rendered in the panel header regardless of `layout`.

---

## Section 3 — Testing

### Gateway (`packages/gateway`)

`PATCH /api/v1/me/preferences` tests (co-located with route file, using `app.inject()`):
- Valid payload (`{ runDetailLayout: 'inline' }`) updates the DB row and returns merged preferences.
- Unknown keys are stripped from the response.
- Unauthenticated request returns 401.

### Web hooks (`packages/web`)

`useUserPreferences` tests (Vitest + React Testing Library, mock fetch):
- Optimistic update fires immediately on `setLayout` call.
- On PATCH error, state reverts to the pre-call value.

### Web components (`packages/web`)

`LayoutToggle`:
- Renders active state on the correct button for both `'split'` and `'inline'` values.
- `onChange` fires with the other value on click.

`SplitRunPanel`:
- Clicking a step row sets `filterNodeId` on the traces panel.
- Clicking "× all" (filter banner clear) sets `filterNodeId` to null (all traces shown).

`StepsTab` (inline mode):
- Clicking a step expands its traces.
- Clicking a second step collapses the first and expands the second (accordion).
- Clicking an expanded step collapses it.

---

## Files Changed

| Package | File | Change |
|---|---|---|
| `shared` | `prisma/schema.prisma` | Add `preferences Json @default("{}")` to `User` |
| `shared` | `prisma/migrations/…` | New migration |
| `gateway` | `src/routes/me.ts` | New GET + PATCH `/me/preferences` endpoints |
| `gateway` | `src/routes/me.test.ts` | Route tests |
| `web` | `src/hooks/useUserPreferences.ts` | New hook |
| `web` | `src/components/LayoutToggle.tsx` | New component |
| `web` | `src/app/runs/[id]/SplitRunPanel.tsx` | New component |
| `web` | `src/app/runs/[id]/page.tsx` | Wire layout toggle + conditional render |

No changes to the worker, CLI, or shared lib beyond the Prisma schema.
