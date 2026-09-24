import type { AgentRow } from '@/hooks/useAgentLibrary';

/** How an agent binds its model, for list views: its own spec, or whom it inherits from. */
export function modelLabel(a: Pick<AgentRow, 'modelSpec' | 'inheritsModelFrom'>): string {
  if (a.modelSpec) {
    return a.modelSpec;
  }
  if (a.inheritsModelFrom) {
    return `↳ inherits ${a.inheritsModelFrom}`;
  }
  return '— (role default)';
}
