import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUN_PLAN_FREE_STEPS, RUN_PLAN_SKELETON_STEPS } from '../workflow/runPlan/stepAllowlist.js';
import { STEP_REQUIRED_AGENTS } from './deploymentAgents.js';
import { RUN_PLAN_STEP_AGENTS, runPlanStepAgentKeys } from './runPlanStepAgents.js';
import { SWE_AGENTS } from './syncBuiltins.js';

const usable = [...RUN_PLAN_FREE_STEPS, ...RUN_PLAN_SKELETON_STEPS];

describe('run plan step -> agent table', () => {
  it('has an entry for every step a plan may use (an empty list is a decision)', () => {
    const missing = usable.filter((s) => !Object.hasOwn(RUN_PLAN_STEP_AGENTS, s));
    expect(
      missing,
      `steps a plan may use but RUN_PLAN_STEP_AGENTS does not mention: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('names only steps a plan may use', () => {
    const stale = Object.keys(RUN_PLAN_STEP_AGENTS).filter((s) => !usable.includes(s));
    expect(stale).toEqual([]);
  });

  it('covers everything the deployment boot gate says the step needs', () => {
    for (const step of usable) {
      const required = STEP_REQUIRED_AGENTS[step] ?? [];
      for (const key of required) {
        expect(RUN_PLAN_STEP_AGENTS[step], `${step} resolves ${key}`).toContain(key);
      }
    }
  });

  it('lists the model parent of every persona it names', () => {
    const parent = new Map(SWE_AGENTS.map((a) => [a.key, a.inheritsModelFrom]));
    for (const step of usable) {
      for (const key of RUN_PLAN_STEP_AGENTS[step] ?? []) {
        const p = parent.get(key);
        if (p) {
          expect(RUN_PLAN_STEP_AGENTS[step], `${step}: ${key} inherits from ${p}`).toContain(p);
        }
      }
    }
  });

  it('names only agents that are seeded', () => {
    const seeded = new Set(SWE_AGENTS.map((a) => a.key));
    for (const step of usable) {
      for (const key of RUN_PLAN_STEP_AGENTS[step] ?? []) {
        expect(seeded.has(key), `${step} -> ${key}`).toBe(true);
      }
    }
  });

  it('includes the agents the canonical core reaches only through steps', () => {
    expect(runPlanStepAgentKeys('executeImplementation')).toEqual(
      expect.arrayContaining(['implementer', 'securityReview'])
    );
    expect(runPlanStepAgentKeys('runReviewNetwork')).toEqual(
      expect.arrayContaining(['reviewer', 'securityReviewer'])
    );
    expect(runPlanStepAgentKeys('commitToMemory')).toContain('commitToMemory');
    expect(runPlanStepAgentKeys('gatherTicketContext')).toContain('ticketContextGatherer');
    expect(runPlanStepAgentKeys('notAStep')).toEqual([]);
  });

  /**
   * The table is hand-maintained, so check it against the source: the agent keys an activity
   * names as string literals must all appear in the table. A heuristic (a key chosen at run time
   * is not seen), but it fails when someone wires a new agent into one of these activities.
   */
  it('contains every agent literal the plan-usable activities name', () => {
    const activities = resolve(dirname(fileURLToPath(import.meta.url)), '../../../worker/src');
    const files = [
      'activities/prdWorkflow.ts',
      'activities/gatherTicketContext.ts',
      'activities/validateContext.ts',
      'activities/prTitle.ts',
      'activities/commitToMemory.ts',
      'activities/executeImplementation.ts',
      'activities/runReviewNetwork.ts',
      'activities/qualityGates.ts',
      'activities/awaitQodoReview.ts',
      'activities/uiVerify.ts',
    ];
    const known = new Set(Object.values(RUN_PLAN_STEP_AGENTS).flat());
    const seeded = new Set(SWE_AGENTS.map((a) => a.key));
    for (const file of files) {
      const src = readFileSync(join(activities, file), 'utf8');
      const literals = [
        ...src.matchAll(/agentKey:\s*'([A-Za-z]+)'/g),
        ...src.matchAll(/resolveAgent\(\s*'([A-Za-z]+)'/g),
        ...src.matchAll(/AGENT_KEY\s*=\s*'([A-Za-z]+)'/g),
      ]
        .map((m) => m[1] as string)
        // `agentKey: 'x'` also labels trace rows and ledger kinds; only seeded agents count.
        .filter((k) => seeded.has(k));
      for (const key of literals) {
        expect(known.has(key), `${file} names agent '${key}' that RUN_PLAN_STEP_AGENTS lacks`).toBe(
          true
        );
      }
    }
  });
});
