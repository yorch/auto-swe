import { handLaunchBlock } from '@auto-swe/shared/lib/channelTask';
import {
  WORKFLOW_CATALOG,
  WORKFLOW_GROUPS,
  workflowPresentation,
} from '@auto-swe/shared/lib/workflowCatalog';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';

export function runnableWorkflows(templates: WorkflowTemplateSummary[], teamId: string | null) {
  return templates.filter(
    (template) =>
      template.status === 'ACTIVE' &&
      template.activeVersion !== null &&
      !handLaunchBlock(template) &&
      (!teamId || template.team === null || template.team.id === teamId)
  );
}

export function defaultWorkflow(templates: WorkflowTemplateSummary[], teamId: string | null) {
  return (
    (teamId && templates.find((template) => template.isDefault && template.team?.id === teamId)) ||
    templates.find((template) => template.isDefault && template.team === null)
  );
}

export function workflowPickerSections(templates: WorkflowTemplateSummary[]) {
  const recent = templates
    .flatMap((template) => {
      const startedAt = Date.parse(template.lastRun?.startedAt ?? '');
      return Number.isFinite(startedAt) ? [{ startedAt, template }] : [];
    })
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 3)
    .map(({ template }) => template);
  const recentIds = new Set(recent.map((template) => template.id));
  const catalogOrder = Object.keys(WORKFLOW_CATALOG);
  const remaining = templates.filter((template) => !recentIds.has(template.id));
  const rank = (template: WorkflowTemplateSummary) => {
    const index = catalogOrder.indexOf(template.name);
    return index === -1 ? catalogOrder.length : index;
  };
  return [
    { id: 'recent', label: 'Recently run', templates: recent },
    ...[
      ...WORKFLOW_GROUPS,
      { id: 'team', label: "Your team's workflows" },
      { id: 'other', label: 'Other' },
    ].map((group) => ({
      ...group,
      templates: remaining
        .filter((template) => workflowPresentation(template).group === group.id)
        .sort((a, b) => rank(a) - rank(b)),
    })),
  ].filter((section) => section.templates.length > 0);
}
