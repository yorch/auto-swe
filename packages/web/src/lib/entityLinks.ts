/** Where a single run opens. */
export function runHref(runId: string): string {
  return `/runs/${encodeURIComponent(runId)}`;
}

/** Where a single workflow template opens. */
export function templateHref(templateId: string): string {
  return `/library/${encodeURIComponent(templateId)}`;
}
