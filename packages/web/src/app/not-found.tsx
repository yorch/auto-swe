import { ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

export default function NotFound() {
  return (
    <div className="flex min-h-[60dvh] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md text-center">
        <p
          aria-hidden="true"
          className="bg-gradient-to-b from-ember-300 to-ember-600 bg-clip-text text-7xl font-semibold tracking-[-0.04em] text-transparent tabular"
        >
          404
        </p>
        <h1 className="mt-4 text-xl font-semibold tracking-tight text-paper-50">Page not found</h1>
        <p className="mt-2 text-sm leading-relaxed text-paper-400">
          That page does not exist, or it has moved. Check the address, or head back home.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <ButtonLink href="/" variant="primary">
            <Icon name="dashboard" size={14} />
            Go home
          </ButtonLink>
          <ButtonLink href="/docs" variant="ghost">
            Browse the docs
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
