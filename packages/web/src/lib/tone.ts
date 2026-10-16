/** Tone for a 0–1 success rate: healthy, worth a look, poor — and neutral when there is none. */
export function successTone(rate: number | null): 'success' | 'warning' | 'danger' | 'default' {
  if (rate === null) {
    return 'default';
  }
  if (rate >= 0.8) {
    return 'success';
  }
  return rate >= 0.5 ? 'warning' : 'danger';
}
