/**
 * Reading a bundle file picked in the browser. The gateway stays the authority on size
 * (`BUNDLE_MAX_BYTES`); the page passes the cap it reports, which only spares an obviously oversize
 * file the upload. This is the gateway's default, used while that answer is loading or unavailable.
 */
export const DEFAULT_BUNDLE_FILE_BYTES = 5_000_000;

/** `5 MB`, `0.5 MB`: the cap as a person reads it. */
export function formatBundleCap(bytes: number): string {
  return `${Number((bytes / 1_000_000).toFixed(1))} MB`;
}

export type BundleFileResult = { ok: true; bundle: unknown } | { ok: false; message: string };

export async function readBundleFile(
  file: File,
  maxBytes: number = DEFAULT_BUNDLE_FILE_BYTES
): Promise<BundleFileResult> {
  if (file.size > maxBytes) {
    return {
      message: `${file.name} is larger than ${formatBundleCap(maxBytes)}, the most a bundle can be.`,
      ok: false,
    };
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { message: `Could not read ${file.name}.`, ok: false };
  }
  try {
    const bundle: unknown = JSON.parse(text);
    if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
      return { message: `${file.name} is not a bundle: expected a JSON object.`, ok: false };
    }
    return { bundle, ok: true };
  } catch {
    return { message: `${file.name} is not valid JSON.`, ok: false };
  }
}
