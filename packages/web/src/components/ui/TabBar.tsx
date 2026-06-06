import { cn } from '@/lib/utils';

interface TabItem<T extends string> {
  id: T;
  label: string;
}

export function TabBar<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('border-b border-ink-600', className)}>
      <nav className="flex gap-1">
        {tabs.map((tab) => (
          <button
            className={`border-b-2 px-4 py-2 text-sm transition-colors ${
              active === tab.id
                ? 'border-ember-400 text-ember-400'
                : 'border-transparent text-paper-400 hover:text-paper-100'
            }`}
            key={tab.id}
            onClick={() => onChange(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
