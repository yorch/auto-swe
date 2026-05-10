'use client';

import { Card } from '@/components/ui/Card';

export default function EpicsPage() {
  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Epics</h2>
      <Card>
        <p className="text-[var(--muted-foreground)] text-center py-8">
          Epic orchestration allows multi-repo changes with dependency ordering. Create epics via
          the API or integrated ticket system.
        </p>
      </Card>
    </div>
  );
}
