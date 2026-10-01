import { Alert } from '@/components/ui/Alert';

export function RestartWarning({ message }: { message?: string }) {
  return (
    <Alert variant="warning">
      {message ??
        'Settings saved. A gateway restart is required for these credential changes to take effect.'}
    </Alert>
  );
}
