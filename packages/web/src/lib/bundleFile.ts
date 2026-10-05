/**
 * Reading a bundle file picked in the browser. The gateway stays the authority on size
 * (`BUNDLE_MAX_BYTES`, 5 MB by default); this cap only spares an obviously oversize file the upload.
 */
export const MAX_BUNDLE_FILE_BYTES = 5_000_000;

export type BundleFileResult = { ok: true; bundle: unknown } | { ok: false; message: string };

export async function readBundleFile(file: File): Promise<BundleFileResult> {
  if (file.size > MAX_BUNDLE_FILE_BYTES) {
    return {
      message: `${file.name} is larger than ${MAX_BUNDLE_FILE_BYTES / 1_000_000} MB, the most a bundle can be.`,
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
