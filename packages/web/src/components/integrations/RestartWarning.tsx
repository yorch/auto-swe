export function RestartWarning({ message }: { message?: string }) {
  return (
    <div className="flex items-start gap-3 rounded-sm border border-amber-400/40 bg-amber-400/10 px-4 py-3">
      <span className="mt-0.5 font-mono text-[11px] text-amber-300">⚠</span>
      <p className="text-sm text-amber-300">
        {message ??
          'Settings saved. A gateway restart is required for these credential changes to take effect.'}
      </p>
    </div>
  );
}
