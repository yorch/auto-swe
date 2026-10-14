import type { WorkflowTemplateDetail } from '@auto-swe/shared/types/api';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { SparkleIcon, SparkleTextIcon } from '@/components/ui/icons';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { TemplateBackLink } from '@/components/workflow/templateNav';
import { VersionTags } from '@/components/workflow/VersionTags';
import { HELP_LINKS } from '@/lib/helpLinks';

interface TemplateHeaderProps {
  template: WorkflowTemplateDetail;
  canManage: boolean;
  onExplain: () => void;
  onRefine: () => void;
  onEditDetails: () => void;
  onEditInputs: () => void;
}

/** Back link, title bar with its actions, and the status badges. */
export function TemplateHeader({
  template,
  canManage,
  onExplain,
  onRefine,
  onEditDetails,
  onEditInputs,
}: TemplateHeaderProps) {
  const runnable = template.status === 'ACTIVE' && template.activeVersion !== null;
  return (
    <div>
      <TemplateBackLink href="/workflows/library" label="Workflow library" />
      <PageHeader
        actions={
          <>
            {template.activeVersion !== null && (
              <Button onClick={onExplain} size="sm" variant="ghost">
                <SparkleTextIcon />
                Explain
              </Button>
            )}
            {canManage && (
              <Button onClick={onRefine} size="sm" variant="secondary">
                <SparkleIcon />
                Refine with AI
              </Button>
            )}
            {runnable && (
              <ButtonLink
                href={`/start?template=${encodeURIComponent(template.id)}`}
                size="sm"
                variant="primary"
              >
                Run
                <Icon name="arrowRight" size={13} />
              </ButtonLink>
            )}
            {canManage && (
              <ActionMenu
                items={[
                  {
                    icon: 'edit',
                    id: 'details',
                    label: 'Edit details',
                    onAction: onEditDetails,
                  },
                  {
                    icon: 'sliders',
                    id: 'inputs',
                    label: 'Edit launch inputs',
                    onAction: onEditInputs,
                  },
                ]}
                label={`More actions for ${template.name}`}
              />
            )}
          </>
        }
        className="mt-3 mb-0"
        learnMore={{ ...HELP_LINKS.architectureNodeTypes, label: 'About node types' }}
        subtitle={
          template.description ||
          'A workflow: its versions, launch inputs, experiment and triggers.'
        }
        title={template.name}
      />
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={template.status} />
        <Badge tone="neutral" variant="outline">
          {template.team?.name ?? 'Platform-wide'}
        </Badge>
        <VersionTags isDefault={template.isDefault} />
        {template.webhookConfigured && (
          <Badge title="A webhook URL can start this workflow" tone="violet" variant="outline">
            Webhook
          </Badge>
        )}
        {template.experimentVersion && (
          <Badge tone="violet" variant="outline">
            A/B test: v{template.experimentVersion} at {template.experimentSplit ?? 0}%
          </Badge>
        )}
      </div>
    </div>
  );
}
