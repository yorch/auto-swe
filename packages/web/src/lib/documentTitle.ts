import { knownPageTitle } from '@/lib/navigation';

const SITE_NAME = 'auto·swe';

/** The browser tab title for a page title; the bare site name when there is none. */
export function formatDocumentTitle(title: string | null | undefined): string {
  return title ? `${title} · ${SITE_NAME}` : SITE_NAME;
}

/**
 * The tab title a route gets before any page-specific data loads. The root layout
 * hands it to Next as metadata, so it is right in server HTML and after every
 * client navigation, where Next renders a fresh `<title>` for the new route.
 */
export function routeDocumentTitle(pathname: string | null | undefined): string {
  return formatDocumentTitle(pathname ? knownPageTitle(pathname) : null);
}
