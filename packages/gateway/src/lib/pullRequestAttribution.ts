export interface PullRequestWorkflowLink {
  repoId: string | null;
  workflow: {
    repoId: string | null;
    temporalWorkflowId: string;
  } | null;
}

export interface AttributedTemplateRun {
  templateId: string | null;
  template: { name: string };
}

export interface TemplateAttribution {
  templateId: string | null;
  templateName: string;
}

export function templateAttributionForPullRequest(
  pullRequest: PullRequestWorkflowLink,
  runsByWorkflowId: ReadonlyMap<string, AttributedTemplateRun>
): TemplateAttribution | null {
  const link = pullRequest.workflow;
  if (!link || link.repoId !== pullRequest.repoId) {
    return null;
  }
  const run = runsByWorkflowId.get(link.temporalWorkflowId);
  return run ? { templateId: run.templateId, templateName: run.template.name } : null;
}
