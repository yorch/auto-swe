import { useMemo } from 'react';
import { summarizeWorkflow } from '@/components/requests/workflowProcess';
import { useWorkflowTemplate } from './useTemplates';

export function useWorkflowProcess(templateId: string) {
  const query = useWorkflowTemplate(templateId);
  const summary = useMemo(
    () => summarizeWorkflow(query.data?.activeVersionSpec?.spec),
    [query.data?.activeVersionSpec?.spec]
  );
  return { query, summary };
}
