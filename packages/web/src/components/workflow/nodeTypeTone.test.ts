import { describe, expect, it } from 'vitest';
import { isIconName } from '@/components/ui/Icon';
import {
  CATEGORY_TONE,
  NODE_TYPE_CATEGORY,
  NODE_TYPE_ICON,
  NODE_TYPE_TONE,
  nodeTypeIcon,
  nodeTypeTone,
} from './nodeTypeTone';

describe('node type categories', () => {
  it('colours by category, so the four human gates share one tone', () => {
    const human = Object.entries(NODE_TYPE_CATEGORY)
      .filter(([, c]) => c === 'human')
      .map(([t]) => t);
    expect(human.sort()).toEqual(['humanApproval', 'humanDecision', 'humanInput', 'humanReview']);
    for (const t of human) {
      expect(nodeTypeTone(t)).toBe(CATEGORY_TONE.human);
    }
  });

  it('keeps shell and container steps apart from the human and control tones', () => {
    expect(NODE_TYPE_CATEGORY.shell).toBe('execution');
    expect(NODE_TYPE_CATEGORY.containerStep).toBe('execution');
    expect(NODE_TYPE_TONE.shell.border).not.toBe(NODE_TYPE_TONE.cond.border);
  });

  it('gives each category its own tone', () => {
    const borders = Object.values(CATEGORY_TONE).map((t) => t.border);
    expect(new Set(borders).size).toBe(borders.length);
  });

  it('draws every kind with a real icon, and an unknown one with a warning', () => {
    for (const icon of Object.values(NODE_TYPE_ICON)) {
      expect(isIconName(icon)).toBe(true);
    }
    expect(nodeTypeIcon('bogus')).toBe('warning');
  });
});
