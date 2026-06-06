export function LoadingState({ message = 'loading…' }: { message?: string }) {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-paper-500">
        <span
          aria-hidden
          className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-ember-400"
        />
        {message}
      </div>
    </div>
  );
}
