import { describe, expect, it } from 'vitest';
import { TOKEN } from '@/lib/palette';
import { CHART_DASHES, CHART_PALETTE, topNWithOther } from './colors';

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function luminance([r, g, b]: [number, number, number]) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** sRGB → CIE Lab (D65). */
function lab([r, g, b]: [number, number, number]): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const deltaE = (a: [number, number, number], b: [number, number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Machado et al. deuteranopia matrix, applied in linear RGB. */
function deuteranopia([r, g, b]: [number, number, number]): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const m = [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ];
  const enc = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  };
  return m.map((row) => enc(row[0] * R + row[1] * G + row[2] * B)) as [number, number, number];
}

describe('CHART_PALETTE', () => {
  it('has no near-duplicate colours, for typical vision or deuteranopia', () => {
    for (let i = 0; i < CHART_PALETTE.length; i++) {
      for (let j = i + 1; j < CHART_PALETTE.length; j++) {
        const a = rgb(CHART_PALETTE[i]);
        const b = rgb(CHART_PALETTE[j]);
        expect(
          deltaE(lab(a), lab(b)),
          `${CHART_PALETTE[i]} vs ${CHART_PALETTE[j]}`
        ).toBeGreaterThan(30);
        expect(
          deltaE(lab(deuteranopia(a)), lab(deuteranopia(b))),
          `deuteranopia ${CHART_PALETTE[i]} vs ${CHART_PALETTE[j]}`
        ).toBeGreaterThan(12);
      }
    }
  });

  it('reads against the dark chart background', () => {
    for (const c of CHART_PALETTE) {
      expect(contrast(c, TOKEN.ink900), c).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('has a dash pattern for every colour', () => {
    expect(CHART_DASHES).toHaveLength(CHART_PALETTE.length);
    expect(new Set(CHART_DASHES).size).toBe(CHART_DASHES.length);
  });
});

describe('topNWithOther', () => {
  const merge = (rest: { k: string; w: number }[]) => ({
    k: 'Other',
    w: rest.reduce((n, r) => n + r.w, 0),
  });
  const weight = (i: { w: number }) => i.w;

  it('leaves a short list alone', () => {
    const items = [{ k: 'a', w: 1 }];
    expect(topNWithOther(items, 3, weight, merge)).toBe(items);
  });

  it('keeps the heaviest and folds the rest into one Other', () => {
    const items = [
      { k: 'a', w: 1 },
      { k: 'b', w: 5 },
      { k: 'c', w: 3 },
      { k: 'd', w: 2 },
    ];
    expect(topNWithOther(items, 3, weight, merge)).toEqual([
      { k: 'b', w: 5 },
      { k: 'c', w: 3 },
      { k: 'Other', w: 3 },
    ]);
  });
});
