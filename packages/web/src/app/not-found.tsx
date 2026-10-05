import { ButtonLink } from '@/components/ui/Button';

export default function NotFound() {
  return (
    <div className="flex min-h-[400px] items-center justify-center p-6 md:p-8">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-xl font-semibold text-paper-100">Page not found</h1>
        <p className="mb-4 text-sm text-paper-400">
          That page does not exist, or it has moved. Check the address, or head back home.
        </p>
        <ButtonLink href="/" variant="primary">
          Go home
        </ButtonLink>
      </div>
    </div>
  );
}
