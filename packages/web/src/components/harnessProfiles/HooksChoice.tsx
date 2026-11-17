import { RadioGroup } from '@/components/ui/RadioGroup';

type Choice = 'off' | 'on';

/**
 * The hook switch at approval. A platform ADMIN chooses it outright: the gateway has no default,
 * so this control always sends an explicit boolean. Off is the pre-selected option, and both are
 * shown so the choice is a visible one. `name` keeps two groups on a page apart.
 */
export function HooksChoice({
  name,
  onChange,
  value,
}: {
  name: string;
  value: boolean;
  onChange: (hooksEnabled: boolean) => void;
}) {
  return (
    <RadioGroup<Choice>
      legend="Hooks"
      name={name}
      onChange={(next) => onChange(next === 'on')}
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
  );
}
