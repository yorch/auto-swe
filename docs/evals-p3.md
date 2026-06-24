# Evals — P3: Drift dashboard, cost control, suite health, optional historical replay

> Build plan for **Phase P3** of the [evals RFC](./evals.md). P3 turns evals into a continuously
> monitored, cost-bounded, self-checking system: an `/admin/evals` **drift dashboard**, **dataset
> compression**, **cost ceilings + tiered scoring**, **suite-health** meta-monitoring, a **golden-set
> re-validation loop**, and — *only if the replay spike cleared* — the **optional historical-replay
> tier**.
>
> Parent RFC: [`evals.md`](./evals.md) §4.5 (drift), §6 (roadmap), §9 (dataset rot, eval-needs-evals,
> cost spiral, on-distribution coverage, the demoted historical-replay tier). Builds on
> [`evals-p1.md`](./evals-p1.md) + [`evals-p2.md`](./evals-p2.md).

---

## Gating prerequisites (RFC §6, §9)

- A **named owner** for dataset governance + judge recalibration (this phase *is* the standing
  maintenance commitment the RFC §9 TCO note warns about — do not start it without an owner).
- The **historical-replay tier** (WS6) is gated on the **replay spike** clearing; if the spike showed
  starting state can't be cheaply reproduced, WS6 is dropped and the frozen-benchmark foundation
  stands alone.

## Outcomes (definition of done)

1. **Drift dashboard** at `/admin/evals`: per-scorer / per-tag trends over time + online sampling
   surfaced (reuses P1 trend queries; copies the `/admin/security` page pattern).
2. **Online sampling** of N% of production runs, scored (trajectory + outcome from existing rows;
   judge on a sampled subset only), feeding the drift trend.
3. **Dataset compression:** an anchor-subset selector (tinyBenchmarks-style) so a large golden set is
   approximated by ~100 anchor cases at low error — a cost lever, not a significance lever (RFC §9).
4. **Cost ceiling + tiered scoring:** a per-suite `costUsd` cap + kill-switch; **hard policy** that
   the cheap floor runs on all cases and the expensive judge only on a sampled anchor subset.
5. **Suite-health meta-monitoring:** flake rate, stale-case rate, and judge κ surfaced as
   **first-class blocking signals** — a degraded suite blocks its own gate (the eval system needs
   evals — RFC §9).
6. **Golden-set re-validation loop:** a periodic job re-runs each case's reference against current
   repo state and **quarantines now-failing (stale) cases** (RFC §9 dataset-rot fix).
7. **(Optional) historical-replay tier:** capture a per-case `baselineSha` + golden test set at run
   time in `executeImplementation`; harvest `MemoryItem.failureType` failures into `EvalCase`s
   (`sourceRunId` provenance) — *iff* the replay spike cleared.
8. **Tests:** drift query + dashboard render; anchor-subset selection error bound; cost ceiling trips
   the kill-switch; tiered policy enforced; suite-health blocks on a seeded degraded suite;
   re-validation quarantines a stale case.

## Non-goals

- Net-new scorer families beyond gate/assert/trajectory/judge.
- A public, customer-facing eval-authoring product surface (only build if a customer pulls — RFC §9
  productization caution).

## The guiding constraint

P3 is mostly **read paths, scheduled jobs, and governance** over data P0–P2 already produce. Cost
discipline is a **hard policy** (ceiling + tiering), not advice. Suite health is itself gated: a
stale/flaky/miscalibrated suite must fail closed rather than emit false confidence.

---

## Workstreams

### WS1 — Drift dashboard + online sampling
**Why:** continuous quality visibility (RFC §4.5).

- **Gateway:** extend the `evals/results/query` trend endpoint (P1) with time-bucketed, per-scorer /
  per-tag aggregates; add an online-sampling writer that scores N% of finalized production runs
  (trajectory + outcome from existing `AgentTrace`/`WorkflowRun` rows; judge only on the sampled
  anchor subset — WS3/WS4).
- **Web:** `/admin/evals/page.tsx` (copy `/admin/security` page + `useAdmin` hooks): per-scorer drift
  lines, per-tag breakdown, suite-health header (WS5). A thin per-run view already exists from P0.
- **Acceptance:** drift trend renders across runs; online sampling rate is configurable; per-tag
  slices match WS-stratified P1 stats.

### WS2 — (folded into WS1) — *reserved*

### WS3 — Dataset compression (anchor subsets)
**Why:** cut eval cost without losing ranking signal (RFC §9).

- **`packages/worker/src/lib/anchorSubset.ts`** (NET-NEW): select ~K anchor cases that approximate the
  full set's score (tinyBenchmarks-style). Used by the nightly harness + online judge sampling.
- **Acceptance:** anchor-subset score tracks full-set score within a stated error on a back-test.

### WS4 — Cost ceiling + tiered scoring
**Why:** evals are the new compute bottleneck (RFC §9).

- **`CostPolicy`** per dataset/suite: a `maxUsdPerRun` ceiling + kill-switch (abort + mark the
  `EvalRun` cost-capped). **Hard tiering policy:** the cheap floor (execution + trajectory) runs on
  all cases; the judge runs **only** on the anchor subset (WS3). Track eval `costUsd` on every
  `EvalResult` (already present from P0) and aggregate per `EvalRun`.
- **Acceptance:** a run exceeding the ceiling trips the kill-switch and records partial results; the
  judge never runs outside the anchor subset.

### WS5 — Suite-health meta-monitoring (eval-needs-evals)
**Why:** a green-but-degraded suite is worse than none (RFC §9).

- Compute + surface **flake rate** (from WS3/P1 flake screening + floor re-runs), **stale-case rate**
  (from WS6), and **judge κ** (from P2 WS4) as first-class signals on `/admin/evals`. **Block the
  gate** when any crosses a threshold (fail closed): a flaky/stale/miscalibrated suite cannot pass a
  candidate.
- **Acceptance:** a seeded high-flake or low-κ suite blocks its own gate verdict and shows red
  health.

### WS6 — Golden-set re-validation loop (dataset-rot fix)
**Why:** stale cases silently become permanent floor-failures (RFC §9).

- **Scheduled job:** re-run each `EvalCase` reference against **current** repo state; if the reference
  no longer passes (the case went stale, not the agent's fault), **quarantine** it (flag + exclude
  from the gate) and alert the owner. Records keep `sourceRunId`/provenance.
- **Acceptance:** a case whose reference stops passing is quarantined and drops out of the gate; the
  owner is notified.

### WS7 — (Optional) historical-replay tier
**Why:** richer coverage that mirrors real traffic — only if it earns its infra cost (RFC §4.3, §9).

- **Gated on the replay spike.** If cleared: capture a per-case `baselineSha` + in-scope golden test
  set at run time in `executeImplementation` (so future replays are deterministic); harvest
  `MemoryItem.failureType` failures into `EvalCase`s with `sourceRunId` provenance and a frozen
  held-out split; replay via the WS2-SHA-pinned workspace from P1. Contamination guard: exclude
  harvested repos/tickets from memory retrieval during eval runs (RFC §9).
- **Acceptance:** a harvested historical case replays deterministically at its captured SHA and
  scores comparably across two identical runs; if the spike did **not** clear, this WS is explicitly
  dropped and noted.

### WS8 — Tests
- Drift query + dashboard (WS1); anchor-subset error bound (WS3); cost ceiling/kill-switch + tiering
  (WS4); suite-health fail-closed (WS5); re-validation quarantine (WS6); deterministic replay (WS7,
  if built).

---

## Exit criteria (RFC §6)

A configurable sample of production runs is scored online; `/admin/evals` shows per-scorer/per-tag
drift trends with a suite-health header; eval `costUsd` is reported and bounded by a hard ceiling +
tiering policy; the golden set self-heals via re-validation; the optional historical-replay tier is
either deterministic-by-construction or explicitly dropped.

## Risk notes carried from RFC §9

- **Dataset rot:** WS6 re-validation + named owner (the standing TCO commitment).
- **Cost spiral:** WS4 ceiling + WS3 anchor subsets + tiered judge are hard policy, not advice.
- **False confidence:** WS5 makes the suite fail closed when it's degraded.
- **Coverage:** WS1 per-tag drift + the P2 canary + a production backstop; evals reduce but never
  eliminate the need for a canary on off-distribution change.
