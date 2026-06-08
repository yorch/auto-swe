# Run Detail Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add split-panel and inline-expansion layouts to the run detail page, with a DB-backed toggle that persists the user's preference.

**Architecture:** A `preferences Json` column on the `User` model stores `{ runDetailLayout: 'split' | 'inline' }`. Two new gateway endpoints (`GET`/`PATCH /api/v1/me/preferences`) read and merge-update it. The web reads the preference via `useUserPreferences`, renders a `LayoutToggle` in the panel header, and conditionally shows either `SplitRunPanel` (steps + traces side by side) or the refactored inline `StepsTab` (traces expand accordion-style below each step).

**Tech Stack:** Prisma 7 (schema + migration), Fastify 5 + Zod (gateway), TanStack Query + React (web), Vitest + RTL (tests), Tailwind CSS (styling).

---

## File Map

| Action | Path |
|---|---|
| Modify | `packages/shared/src/prisma/schema.prisma` |
| Create | `packages/shared/src/prisma/migrations/<timestamp>_add_user_preferences/migration.sql` |
| Create | `packages/gateway/src/routes/me.ts` |
| Create | `packages/gateway/src/routes/me.test.ts` |
| Modify | `packages/gateway/src/index.ts` |
| Create | `packages/web/src/hooks/useUserPreferences.ts` |
| Create | `packages/web/src/components/LayoutToggle.tsx` |
| Create | `packages/web/src/app/runs/[id]/SplitRunPanel.tsx` |
| Modify | `packages/web/src/app/runs/[id]/page.tsx` |

---

## Task 1: Prisma — add `preferences` to User

**Files:**
- Modify: `packages/shared/src/prisma/schema.prisma`

- [ ] **Step 1: Add the column to the User model**

In `schema.prisma`, find the `model User` block and add the `preferences` field after `updatedAt`:

```prisma
  updatedAt      DateTime       @default(now()) @updatedAt @map("updated_at") @db.Timestamptz
  preferences    Json           @default("{}") @map("preferences")
```

- [ ] **Step 2: Create and run the migration**

```bash
cd /path/to/repo
yarn db:migrate dev --name add_user_preferences
```

Expected output: `The following migration(s) have been created and applied … add_user_preferences`

- [ ] **Step 3: Regenerate the Prisma client**

```bash
yarn db:generate
```

Expected output: `Generated Prisma Client … to node_modules/.prisma/client`

- [ ] **Step 4: Typecheck to confirm the new field is visible**

```bash
yarn typecheck
```

Expected: exits 0 with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/prisma/schema.prisma packages/shared/src/prisma/migrations/
git commit -m "feat: add preferences Json column to User model"
```

---

## Task 2: Gateway — `me.ts` route (GET + PATCH preferences)

**Files:**
- Create: `packages/gateway/src/routes/me.ts`

- [ ] **Step 1: Write the failing test first** *(covered in Task 3 — write tests before wiring, but create the file now so the import resolves)*

Create `packages/gateway/src/routes/me.ts` with this content:

```typescript
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireUser } from '../plugins/auth.js';

const PreferencesBodySchema = z.object({
  runDetailLayout: z.enum(['split', 'inline']).optional(),
});

export const meRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // GET /api/v1/me/preferences
  app.get(
    '/preferences',
    { onRequest: requireAuth({ requiredRole: 'ENGINEER' }) },
    async (request) => {
      const { sub } = requireUser(request);
      const user = await fastify.prisma.user.findUniqueOrThrow({
        select: { preferences: true },
        where: { id: sub },
      });
      return { preferences: user.preferences };
    }
  );

  // PATCH /api/v1/me/preferences
  app.patch(
    '/preferences',
    {
      onRequest: requireAuth({ requiredRole: 'ENGINEER' }),
      schema: { body: PreferencesBodySchema },
    },
    async (request) => {
      const { sub } = requireUser(request);
      const existing = await fastify.prisma.user.findUniqueOrThrow({
        select: { preferences: true },
        where: { id: sub },
      });
      const merged = {
        ...(existing.preferences as Record<string, unknown>),
        ...request.body,
      };
      const updated = await fastify.prisma.user.update({
        data: { preferences: merged },
        select: { preferences: true },
        where: { id: sub },
      });
      return { preferences: updated.preferences };
    }
  );
};
```

- [ ] **Step 2: Register the route in `packages/gateway/src/index.ts`**

Add the import near the other route imports:

```typescript
import { meRoutes } from './routes/me.js';
```

Then add the registration after the `userRoutes` line:

```typescript
  await app.register(meRoutes, { prefix: '/api/v1/me' });
```

- [ ] **Step 3: Typecheck**

```bash
yarn typecheck
```

Expected: exits 0.

---

## Task 3: Gateway — `me.test.ts`

**Files:**
- Create: `packages/gateway/src/routes/me.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { meRoutes } from './me.js';

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const mockPrisma = {
    user: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
  };

  const mockAuth = {
    verifyAccessToken: () => ({
      exp: 9999999999,
      iat: 0,
      role: 'ENGINEER' as const,
      sub: 'user-1',
    }),
  };

  app.decorate('prisma', mockPrisma as unknown as never);
  app.decorate('auth', mockAuth as unknown as never);

  await app.register(meRoutes, { prefix: '/api/v1/me' });
  await app.ready();

  return { app, mockPrisma };
}

const AUTH_HEADER = { authorization: 'Bearer fake-jwt' };

describe('meRoutes', () => {
  let ctx: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => { ctx = await buildApp(); });
  afterAll(() => ctx.app.close());
  beforeEach(() => {
    ctx.mockPrisma.user.findUniqueOrThrow.mockClear();
    ctx.mockPrisma.user.update.mockClear();
  });

  describe('GET /api/v1/me/preferences', () => {
    it('returns the user preferences', async () => {
      ctx.mockPrisma.user.findUniqueOrThrow.mockResolvedValueOnce({
        preferences: { runDetailLayout: 'split' },
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'GET',
        url: '/api/v1/me/preferences',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({
        preferences: { runDetailLayout: 'split' },
      });
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/me/preferences',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PATCH /api/v1/me/preferences', () => {
    it('merges the new value and returns updated preferences', async () => {
      ctx.mockPrisma.user.findUniqueOrThrow.mockResolvedValueOnce({
        preferences: { runDetailLayout: 'split' },
      });
      ctx.mockPrisma.user.update.mockResolvedValueOnce({
        preferences: { runDetailLayout: 'inline' },
      });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        payload: { runDetailLayout: 'inline' },
        url: '/api/v1/me/preferences',
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload)).toEqual({
        preferences: { runDetailLayout: 'inline' },
      });
      expect(ctx.mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { preferences: { runDetailLayout: 'inline' } },
        })
      );
    });

    it('strips unknown keys from the request body', async () => {
      ctx.mockPrisma.user.findUniqueOrThrow.mockResolvedValueOnce({
        preferences: {},
      });
      ctx.mockPrisma.user.update.mockResolvedValueOnce({ preferences: {} });

      const res = await ctx.app.inject({
        headers: AUTH_HEADER,
        method: 'PATCH',
        // `unknownKey` is not in the Zod schema and should be stripped
        payload: { unknownKey: 'evil', runDetailLayout: 'split' },
        url: '/api/v1/me/preferences',
      });

      expect(res.statusCode).toBe(200);
      // The update was called with only the whitelisted key
      expect(ctx.mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { preferences: { runDetailLayout: 'split' } },
        })
      );
    });

    it('returns 401 without auth', async () => {
      const res = await ctx.app.inject({
        method: 'PATCH',
        payload: { runDetailLayout: 'inline' },
        url: '/api/v1/me/preferences',
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
```

- [ ] **Step 2: Run the tests — expect them to pass**

```bash
yarn test packages/gateway/src/routes/me.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/routes/me.ts packages/gateway/src/routes/me.test.ts packages/gateway/src/index.ts
git commit -m "feat: GET/PATCH /api/v1/me/preferences endpoint"
```

---

## Task 4: Web — `useUserPreferences` hook

**Files:**
- Create: `packages/web/src/hooks/useUserPreferences.ts`

- [ ] **Step 1: Create the hook**

```typescript
'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

type RunDetailLayout = 'split' | 'inline';

interface UserPreferences {
  runDetailLayout?: RunDetailLayout;
}

interface PreferencesResponse {
  preferences: UserPreferences;
}

const QUERY_KEY = ['me-preferences'] as const;
const DEFAULT_LAYOUT: RunDetailLayout = 'split';

export function useUserPreferences() {
  const qc = useQueryClient();

  const { data } = useQuery({
    queryFn: () =>
      api.get<PreferencesResponse>('/api/v1/me/preferences').then((r) => r.preferences),
    queryKey: QUERY_KEY,
    staleTime: 5 * 60 * 1000,
  });

  const mutation = useMutation({
    mutationFn: (layout: RunDetailLayout) =>
      api.patch<PreferencesResponse>('/api/v1/me/preferences', { runDetailLayout: layout }),
    onError: (_err, _vars, ctx) => {
      if (ctx) {
        qc.setQueryData(QUERY_KEY, ctx);
      }
    },
    onMutate: async (layout) => {
      await qc.cancelQueries({ queryKey: QUERY_KEY });
      const prev = qc.getQueryData<UserPreferences>(QUERY_KEY);
      qc.setQueryData(QUERY_KEY, { ...prev, runDetailLayout: layout });
      return prev;
    },
  });

  return {
    layout: data?.runDetailLayout ?? DEFAULT_LAYOUT,
    setLayout: mutation.mutate,
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
yarn typecheck
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/hooks/useUserPreferences.ts
git commit -m "feat: useUserPreferences hook with optimistic update"
```

---

## Task 5: Web — `LayoutToggle` component

**Files:**
- Create: `packages/web/src/components/LayoutToggle.tsx`

- [ ] **Step 1: Create the component**

```tsx
'use client';

type RunDetailLayout = 'split' | 'inline';

interface LayoutToggleProps {
  value: RunDetailLayout;
  onChange: (v: RunDetailLayout) => void;
}

export function LayoutToggle({ value, onChange }: LayoutToggleProps) {
  return (
    <div className="flex items-center gap-px bg-ink-700 rounded p-0.5">
      <button
        aria-label="Split panel layout"
        className={`p-1 rounded transition-colors ${
          value === 'split' ? 'bg-ink-500 text-paper-100' : 'text-paper-400 hover:text-paper-200'
        }`}
        onClick={() => onChange('split')}
        title="Split panel"
        type="button"
      >
        {/* Two-column split icon */}
        <svg fill="none" height="14" viewBox="0 0 14 14" width="14">
          <rect height="10" rx="1" stroke="currentColor" strokeWidth="1.2" width="5" x="1" y="2" />
          <rect height="10" rx="1" stroke="currentColor" strokeWidth="1.2" width="5" x="8" y="2" />
        </svg>
      </button>
      <button
        aria-label="Inline list layout"
        className={`p-1 rounded transition-colors ${
          value === 'inline' ? 'bg-ink-500 text-paper-100' : 'text-paper-400 hover:text-paper-200'
        }`}
        onClick={() => onChange('inline')}
        title="Inline list"
        type="button"
      >
        {/* List with indent lines icon */}
        <svg fill="none" height="14" viewBox="0 0 14 14" width="14">
          <line stroke="currentColor" strokeWidth="1.2" x1="2" x2="12" y1="4" y2="4" />
          <line stroke="currentColor" strokeWidth="1.2" x1="2" x2="12" y1="7" y2="7" />
          <line stroke="currentColor" strokeWidth="1.2" x1="4" x2="12" y1="10" y2="10" />
        </svg>
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
yarn typecheck
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/LayoutToggle.tsx
git commit -m "feat: LayoutToggle component for run detail panel"
```

---

## Task 6: Web — `SplitRunPanel` component

**Files:**
- Create: `packages/web/src/app/runs/[id]/SplitRunPanel.tsx`

This component renders the split-panel layout: steps list on the left, traces on the right. It imports `TracesTab` directly from `page.tsx`'s module — since both live in the same directory, you'll need to ensure `TracesTab` is exported from `page.tsx` (done in Task 8 step 1).

- [ ] **Step 1: Create the component**

```tsx
'use client';

import type { AgentTraceRecord, WorkflowStepRecord } from '@auto-swe/shared/types/api';
import { StatusBadge } from '@/components/StatusBadge';
import { formatDate } from '@/lib/utils';
import { TracesTab } from './TracesTab';

interface SplitRunPanelProps {
  activityToNodeId: Record<string, string>;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  steps: WorkflowStepRecord[];
  traces: AgentTraceRecord[];
}

export function SplitRunPanel({
  activityToNodeId,
  selectedNodeId,
  onSelectNode,
  steps,
  traces,
}: SplitRunPanelProps) {
  const handleSelect = (nodeId: string) => {
    onSelectNode(selectedNodeId === nodeId ? null : nodeId);
  };

  return (
    <div className="flex min-h-48 max-h-[60vh]">
      {/* Steps column */}
      <div className="w-[38%] shrink-0 border-r border-ink-600 overflow-y-auto">
        <div className="px-3 py-1.5 bg-ink-900/60 border-b border-ink-600 text-[10px] uppercase tracking-widest text-paper-400">
          Steps · {steps.length}
        </div>
        {steps.length === 0 ? (
          <div className="py-8 text-center text-sm text-paper-400">No steps recorded yet.</div>
        ) : (
          <div className="divide-y divide-ink-600/50">
            {steps.map((s) => (
              <button
                className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-ink-800/40 ${
                  selectedNodeId === s.nodeId ? 'bg-ink-800/60' : ''
                }`}
                key={s.id}
                onClick={() => handleSelect(s.nodeId)}
                type="button"
              >
                <div className="pt-0.5 shrink-0">
                  <StatusBadge status={s.status} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`text-xs font-mono truncate ${
                        selectedNodeId === s.nodeId ? 'text-ember-300' : 'text-paper-200'
                      }`}
                    >
                      {s.nodeId}
                    </span>
                    <span className="text-[10px] text-paper-400 shrink-0">×{s.attempt}</span>
                  </div>
                  {s.error && (
                    <div className="text-[10px] text-brick-400 mt-0.5 truncate">{s.error}</div>
                  )}
                  {(s.startedAt || s.endedAt) && (
                    <div className="text-[10px] text-paper-400 mt-0.5">
                      {s.startedAt ? formatDate(s.startedAt) : '?'}
                      {s.endedAt ? ` → ${formatDate(s.endedAt)}` : ''}
                    </div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Traces column */}
      <div className="flex-1 overflow-y-auto">
        <TracesTab
          activityToNodeId={activityToNodeId}
          filterNodeId={selectedNodeId}
          onClearFilter={() => setSelectedNodeId(null)}
          traces={traces}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck (will fail until TracesTab is exported — proceed to Task 8 step 1 first)**

```bash
yarn typecheck 2>&1 | grep SplitRunPanel
```

---

## Task 7: Refactor `page.tsx` — extract `TracesTab`, add inline expansion, wire layout

**Files:**
- Create: `packages/web/src/app/runs/[id]/TracesTab.tsx`
- Modify: `packages/web/src/app/runs/[id]/page.tsx`

This is the largest change. It's split into fine-grained sub-steps.

### Step 1 — Extract `TracesTab` and `TraceEventList` to their own file

- [ ] **Step 1a: Create `TracesTab.tsx`**

Cut `TraceEventList`, `TracesTab`, and the `TraceGroup` interface out of `page.tsx` and paste them into a new file. Add `'use client'` and the necessary imports:

```tsx
'use client';

import { useCallback, useMemo, useState } from 'react';
import type { AgentTraceRecord } from '@auto-swe/shared/types/api';

// ── Types ────────────────────────────────────────────────────────────────────

interface TraceGroup {
  activityName: string;
  attempt: number;
  dagNodeId: string | null;
  traces: AgentTraceRecord[];
}

// ── TraceEventList ────────────────────────────────────────────────────────────
// (paste the full existing TraceEventList component here, unchanged)

// ── TracesTab ─────────────────────────────────────────────────────────────────
// (paste the full existing TracesTab component here, unchanged)
// Make sure it is exported:
export function TracesTab({ ... }) { ... }
```

> **Note:** Copy the exact implementations from `page.tsx` — do not modify the logic during this extraction.

- [ ] **Step 1b: Remove `TraceEventList`, `TracesTab`, and `TraceGroup` from `page.tsx`**

Replace those declarations in `page.tsx` with a single import:

```tsx
import { TracesTab } from './TracesTab';
```

- [ ] **Step 1c: Typecheck**

```bash
yarn typecheck
```

Expected: exits 0. The page renders identically — this is purely a file split.

- [ ] **Step 1d: Commit**

```bash
git add packages/web/src/app/runs/[id]/TracesTab.tsx packages/web/src/app/runs/[id]/page.tsx
git commit -m "refactor: extract TracesTab to its own file"
```

### Step 2 — Add `compact` prop to `TracesTab` (hides filter banner in inline mode)

- [ ] **Step 2a: Update `TracesTab.tsx`**

Add `compact?: boolean` to the `TracesTab` props interface. When `compact` is true, skip rendering the filter banner div:

```tsx
export function TracesTab({
  traces,
  filterNodeId,
  activityToNodeId,
  onClearFilter,
  compact = false,
}: {
  traces: AgentTraceRecord[];
  filterNodeId: string | null;
  activityToNodeId: Record<string, string>;
  onClearFilter: () => void;
  compact?: boolean;
}) {
  // ...existing body...

  return (
    <div>
      {!compact && filterNodeId && (
        // ...existing filter banner...
      )}
      {/* rest unchanged */}
    </div>
  );
}
```

- [ ] **Step 2b: Typecheck**

```bash
yarn typecheck
```

Expected: exits 0.

### Step 3 — Add inline expansion to `StepsTab`

- [ ] **Step 3a: Update `StepsTab` in `page.tsx`**

Replace the existing `StepsTab` function with this version that supports accordion expansion. Note: this is a complete replacement of the `StepsTab` function — locate it by its `function StepsTab(` declaration.

```tsx
function StepsTab({
  activityToNodeId,
  steps,
  traces,
}: {
  activityToNodeId: Record<string, string>;
  steps: WorkflowStepRecord[];
  traces: AgentTraceRecord[];
}) {
  const [expandedNodeId, setExpandedNodeId] = useState<string | null>(null);

  const toggle = (nodeId: string) =>
    setExpandedNodeId((prev) => (prev === nodeId ? null : nodeId));

  if (steps.length === 0) {
    return <div className="py-12 text-center text-sm text-paper-400">No steps recorded yet.</div>;
  }

  return (
    <div className="divide-y divide-ink-600/50">
      {steps.map((s) => (
        <div key={s.id}>
          <button
            className="w-full flex items-start gap-3 px-4 py-3 hover:bg-ink-800/40 transition-colors text-left"
            onClick={() => toggle(s.nodeId)}
            type="button"
          >
            <div className="pt-0.5 shrink-0">
              <StatusBadge status={s.status} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-mono text-paper-200 truncate">{s.nodeId}</span>
                <span className="text-xs text-paper-400 shrink-0">attempt {s.attempt}</span>
              </div>
              {s.error && (
                <div className="text-xs text-brick-400 mt-0.5 truncate">{s.error}</div>
              )}
              {(s.startedAt || s.endedAt) && (
                <div className="text-xs text-paper-400 mt-0.5">
                  {s.startedAt ? formatDate(s.startedAt) : '?'}
                  {s.endedAt ? ` → ${formatDate(s.endedAt)}` : ''}
                </div>
              )}
            </div>
            <span className="text-[10px] text-paper-400 shrink-0 pt-1">
              {expandedNodeId === s.nodeId ? '▲' : '▶'}
            </span>
          </button>
          {expandedNodeId === s.nodeId && (
            <div className="border-t border-ink-600/50 bg-ink-900/30">
              <TracesTab
                activityToNodeId={activityToNodeId}
                compact
                filterNodeId={s.nodeId}
                onClearFilter={() => {}}
                traces={traces}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
```

Remove the `onNodeClick` prop from `StepsTab` — it's no longer needed. The parent in inline mode handles DAG clicks separately (see Task 7 step 4).

- [ ] **Step 3b: Typecheck**

```bash
yarn typecheck
```

Expected: exits 0.

### Step 4 — Wire `RunDetailPage` for both layouts

- [ ] **Step 4a: Add the layout hook and `LayoutToggle` to `RunDetailPage`**

At the top of the `RunDetailPage` function body (after existing state declarations), add:

```tsx
const { layout, setLayout } = useUserPreferences();
```

- [ ] **Step 4b: Add imports at the top of `page.tsx`**

```tsx
import { LayoutToggle } from '@/components/LayoutToggle';
import { useUserPreferences } from '@/hooks/useUserPreferences';
import { SplitRunPanel } from './SplitRunPanel';
```

- [ ] **Step 4c: Remove the `useEffect` that auto-switched to traces tab**

Delete these lines (they're no longer needed — the split panel has no tabs to switch):

```tsx
  // Clicking a DAG node always switches to the traces tab
  useEffect(() => {
    if (selectedNodeId) {
      setActiveTab('traces');
    }
  }, [selectedNodeId]);
```

Replace `handleNodeClick` with a version that handles both layouts:

```tsx
  const handleNodeClick = (nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    if (layout === 'inline' && nodeId) {
      setActiveTab('steps');
    }
  };
```

- [ ] **Step 4d: Update the bottom panel to render based on `layout`**

Find the `{/* Bottom tabbed panel */}` comment and replace everything from that `<Card>` to its closing `</Card>` with:

```tsx
        {/* Bottom tabbed panel */}
        <Card className="overflow-hidden p-0">
          {/* Tab bar — adapts to layout */}
          <div className="flex items-center border-b border-ink-600 px-2">
            {layout === 'split' ? (
              <>
                <span className="flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 border-ember-400 text-paper-100 -mb-px">
                  Run
                </span>
                {securityEvents.length > 0 && (
                  <button
                    className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                      activeTab === 'security'
                        ? 'border-ember-400 text-paper-100'
                        : 'border-transparent text-paper-400 hover:text-paper-200'
                    }`}
                    onClick={() => setActiveTab('security')}
                    type="button"
                  >
                    Security
                    <span className="text-[10px] font-mono px-1.5 py-px rounded-full bg-ink-600 text-paper-400">
                      {securityEvents.length}
                    </span>
                  </button>
                )}
              </>
            ) : (
              TABS.map((tab) => (
                <button
                  className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
                    activeTab === tab.id
                      ? 'border-ember-400 text-paper-100'
                      : 'border-transparent text-paper-400 hover:text-paper-200'
                  }`}
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  type="button"
                >
                  {tab.label}
                  {tab.count != null && (
                    <span
                      className={`text-[10px] font-mono px-1.5 py-px rounded-full ${
                        activeTab === tab.id
                          ? 'bg-ember-400/20 text-ember-300'
                          : 'bg-ink-600 text-paper-400'
                      }`}
                    >
                      {tab.count}
                    </span>
                  )}
                </button>
              ))
            )}
            <div className="ml-auto pr-2 flex items-center">
              <LayoutToggle onChange={setLayout} value={layout} />
            </div>
          </div>

          {/* Tab content */}
          {layout === 'split' ? (
            activeTab === 'security' ? (
              <div className="min-h-48 max-h-[60vh] overflow-y-auto p-4">
                <SecurityEventList events={securityEvents} />
              </div>
            ) : (
              <SplitRunPanel
                activityToNodeId={activityToNodeId}
                onSelectNode={setSelectedNodeId}
                selectedNodeId={selectedNodeId}
                steps={run.steps}
                traces={traces}
              />
            )
          ) : (
            <div className="min-h-48 max-h-[60vh] overflow-y-auto">
              {activeTab === 'traces' && (
                <TracesTab
                  activityToNodeId={activityToNodeId}
                  filterNodeId={selectedNodeId}
                  onClearFilter={() => setSelectedNodeId(null)}
                  traces={traces}
                />
              )}
              {activeTab === 'steps' && (
                <StepsTab
                  activityToNodeId={activityToNodeId}
                  steps={run.steps}
                  traces={traces}
                />
              )}
              {activeTab === 'security' &&
                (securityEvents.length > 0 ? (
                  <div className="p-4">
                    <SecurityEventList events={securityEvents} />
                  </div>
                ) : (
                  <div className="py-12 text-center text-sm text-paper-400">
                    No security events.
                  </div>
                ))}
            </div>
          )}
        </Card>
```

- [ ] **Step 4e: Typecheck**

```bash
yarn typecheck
```

Expected: exits 0.

- [ ] **Step 4f: Commit**

```bash
git add packages/web/src/app/runs/[id]/
git commit -m "feat: split-panel and inline-expansion layouts for run detail"
```

---

## Task 8: Component tests

**Files:**
- Create: `packages/web/src/components/LayoutToggle.test.tsx`
- Create: `packages/web/src/app/runs/[id]/TracesTab.test.tsx`

- [ ] **Step 1: Write `LayoutToggle` tests**

```tsx
// packages/web/src/components/LayoutToggle.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LayoutToggle } from './LayoutToggle';

describe('LayoutToggle', () => {
  it('marks split button as active when value is split', () => {
    render(<LayoutToggle onChange={vi.fn()} value="split" />);
    expect(screen.getByLabelText('Split panel layout').className).toContain('bg-ink-500');
    expect(screen.getByLabelText('Inline list layout').className).not.toContain('bg-ink-500');
  });

  it('marks inline button as active when value is inline', () => {
    render(<LayoutToggle onChange={vi.fn()} value="inline" />);
    expect(screen.getByLabelText('Inline list layout').className).toContain('bg-ink-500');
    expect(screen.getByLabelText('Split panel layout').className).not.toContain('bg-ink-500');
  });

  it('calls onChange with "inline" when inline button is clicked', async () => {
    const onChange = vi.fn();
    render(<LayoutToggle onChange={onChange} value="split" />);
    await userEvent.click(screen.getByLabelText('Inline list layout'));
    expect(onChange).toHaveBeenCalledWith('inline');
  });

  it('calls onChange with "split" when split button is clicked', async () => {
    const onChange = vi.fn();
    render(<LayoutToggle onChange={onChange} value="inline" />);
    await userEvent.click(screen.getByLabelText('Split panel layout'));
    expect(onChange).toHaveBeenCalledWith('split');
  });
});
```

- [ ] **Step 2: Write inline expansion tests (`StepsTab` accordion)**

These test the `StepsTab` component extracted into a testable shape. Since `StepsTab` is defined inside `page.tsx`, test it via the import path by rendering `page.tsx` — but that pulls in too many dependencies. Instead, the inline expansion behavior lives in the component: a second click on a step collapses it.

Add tests to `packages/web/src/app/runs/[id]/TracesTab.test.tsx` testing the inline accordion behavior via a minimal wrapper that mocks the trace data:

```tsx
// packages/web/src/app/runs/[id]/TracesTab.test.tsx
/// <reference types="vitest/globals" />
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TracesTab } from './TracesTab';
import type { AgentTraceRecord } from '@auto-swe/shared/types/api';

const makeTrace = (nodeId: string, id = nodeId): AgentTraceRecord => ({
  attempt: 1,
  createdAt: '2026-01-01T00:00:00Z',
  durationMs: 100,
  error: null,
  id,
  inputJson: null,
  nodeId,
  outputJson: null,
  role: 'implementer',
  toolName: null,
  traceType: 'llm_response',
});

describe('TracesTab', () => {
  it('shows all traces when filterNodeId is null', () => {
    const traces = [makeTrace('implement'), makeTrace('review')];
    render(
      <TracesTab
        activityToNodeId={{}}
        filterNodeId={null}
        onClearFilter={() => {}}
        traces={traces}
      />
    );
    expect(screen.getByText('implement')).toBeInTheDocument();
    expect(screen.getByText('review')).toBeInTheDocument();
  });

  it('shows only matching traces when filterNodeId is set', () => {
    const traces = [makeTrace('implement'), makeTrace('review')];
    render(
      <TracesTab
        activityToNodeId={{}}
        filterNodeId="implement"
        onClearFilter={() => {}}
        traces={traces}
      />
    );
    expect(screen.getByText('implement')).toBeInTheDocument();
    expect(screen.queryByText('review')).not.toBeInTheDocument();
  });

  it('hides the filter banner when compact=true', () => {
    const traces = [makeTrace('implement')];
    render(
      <TracesTab
        activityToNodeId={{}}
        compact
        filterNodeId="implement"
        onClearFilter={() => {}}
        traces={traces}
      />
    );
    expect(screen.queryByText(/Filtered to/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run all new tests**

```bash
yarn test packages/web/src/components/LayoutToggle.test.tsx packages/web/src/app/runs/\\[id\\]/TracesTab.test.tsx
```

Expected: all tests pass.

- [ ] **Step 4: Run full test suite to check for regressions**

```bash
yarn test
```

Expected: all tests pass.

- [ ] **Step 5: Lint**

```bash
yarn lint
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/LayoutToggle.test.tsx packages/web/src/app/runs/\[id\]/TracesTab.test.tsx
git commit -m "test: LayoutToggle and TracesTab component tests"
```

---

## Final verification

- [ ] Run `yarn typecheck && yarn lint && yarn test` — all must pass before marking done.
- [ ] Start `yarn dev:web` and `yarn dev:gateway`, open a run detail page at `http://localhost:3000/runs/<id>`, toggle between layouts, confirm the preference persists across a page reload.
