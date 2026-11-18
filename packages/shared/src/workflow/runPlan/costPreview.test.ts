import { describe, expect, it } from 'vitest';
import { estimateSpecCost } from '../costEstimator.js';
import { getStepMetadata, hasStep, listAllSteps } from '../stepRegistry.js';
import { estimateRunPlanCost } from './costPreview.js';
import { deliveringRaw, outputOnlyRaw, parse } from './skeletonFixtures.js';

describe('estimateRunPlanCost', () => {
  it('matches the shared estimator and adds only a sentence about exclusions', () => {
    const spec = parse(deliveringRaw());
    const direct = estimateSpecCost(spec, {
      stepLookup: (n) => (hasStep(n) ? getStepMetadata(n) : undefined),
    });
    const preview = estimateRunPlanCost(spec);
    expect(preview.totalUsd).toBe(direct.totalUsd);
    expect(preview.perStep).toEqual(direct.perStep);
    expect(preview.unpriced).toEqual(direct.unpriced);
    expect(preview.fanOutWidthAssumed).toBe(direct.fanOutWidthAssumed);
    expect(preview.totalUsd).toBeGreaterThan(0);
    expect(preview.exclusions).toContain('loops');
  });

  it('prices an agent node from the agent hint and lists a hintless agent step as unpriced', () => {
    const preview = estimateRunPlanCost(parse(outputOnlyRaw()));
    expect(preview.perStep.map((p) => p.nodeId)).toContain('draft');
    const raw = outputOnlyRaw();
    const hintless = listAllSteps().find((s) => s.category === 'agent' && !s.costHint);
    expect(hintless).toBeDefined();
    raw.nodes.draft = { next: 'reviewDraft', step: hintless?.name, type: 'step' };
    const estimate = estimateRunPlanCost(parse(raw));
    expect(estimate.unpriced.map((u) => u.nodeId)).toContain('draft');
  });

  it('passes pricing and fan-out width through', () => {
    const spec = parse(deliveringRaw());
    const pricey = estimateRunPlanCost(spec, {
      fanOutWidth: 9,
      pricing: { implementer: { inputUsdPerM: 400, outputUsdPerM: 2000 } },
    });
    expect(pricey.fanOutWidthAssumed).toBe(9);
    expect(pricey.totalUsd).toBeGreaterThan(estimateRunPlanCost(spec).totalUsd);
  });
});
