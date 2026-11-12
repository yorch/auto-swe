import { humanizeKey } from './govLabels';

const OVERRIDES: Record<string, string> = {
  connectionId: 'Repository',
  githubRunId: 'GitHub run ID',
};

const ACRONYMS: Record<string, string> = {
  api: 'API',
  ci: 'CI',
  id: 'ID',
  pr: 'PR',
  prd: 'PRD',
  url: 'URL',
};

export function humanizeWorkflowKey(key: string): string {
  if (Object.hasOwn(OVERRIDES, key)) {
    return OVERRIDES[key] ?? key;
  }
  return humanizeKey(key.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2'))
    .split(' ')
    .map((word, index) =>
      Object.hasOwn(ACRONYMS, word.toLowerCase())
        ? ACRONYMS[word.toLowerCase()]
        : index
          ? word.toLowerCase()
          : word
    )
    .join(' ');
}

export function workflowFieldLabel(
  key: string,
  property?: { title?: unknown; type?: unknown; connectionType?: unknown }
): string {
  if (typeof property?.title === 'string') {
    return property.title;
  }
  if (
    key === 'connectionId' &&
    property?.type === 'connection' &&
    typeof property.connectionType === 'string' &&
    property.connectionType !== 'git_repo'
  ) {
    return `${humanizeWorkflowKey(property.connectionType)} connection`;
  }
  return humanizeWorkflowKey(key);
}
