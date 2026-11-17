import { Checkbox } from '@/components/ui/Checkbox';
import { RadioGroup } from '@/components/ui/RadioGroup';
import { HOOKS_REVIEWED_LABEL } from './AutoRunSources';

type Choice = 'off' | 'on';

/**
 * The hook switch at approval. A platform ADMIN chooses it outright: the gateway has no default,
 * so this control always sends an explicit boolean. Off is the pre-selected option, and both are
 * shown so the choice is a visible one. Choosing On asks for the same "reviewed" confirmation as
 * the switch on a saved plugin; the caller keeps its approve button disabled until
 * `hooksConfirmed`. `name` keeps two groups on a page apart.
 */
export function HooksChoice({
  hooksConfirmed,
  name,
  onChange,
  onConfirmedChange,
  value,
}: {
  name: string;
  value: boolean;
  onChange: (hooksEnabled: boolean) => void;
  hooksConfirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
}) {
  return (
    <div className="space-y-2">
      <RadioGroup<Choice>
        legend="Hooks"
        name={name}
        onChange={(next) => {
          onConfirmedChange(false);
          onChange(next === 'on');
        }}
        options={[
          {
            description:
              'Hook configs are not written into the run container. Scripts and executable files are still written.',
            label: 'Hooks off',
            value: 'off',
          },
          {
            description:
              'The plugin’s hooks run commands in the run container with the agent’s authority. Read the hook files first.',
            label: 'Hooks on',
            value: 'on',
          },
        ]}
        value={value ? 'on' : 'off'}
      />
      {value && (
        <Checkbox
          checked={hooksConfirmed}
          label={HOOKS_REVIEWED_LABEL}
          onChange={(e) => onConfirmedChange(e.target.checked)}
        />
      )}
    </div>
  );
}
