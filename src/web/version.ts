import manifest from "../../package.json";

/** Shared application release version; the build bundles this manifest value. */
export const APP_VERSION = manifest.version;

/** Render the same versioned HTML in development and self-contained release builds. */
export function renderVersionedShell(html: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(APP_VERSION)) throw new Error("app_version_invalid");
  return html.replaceAll("__SEA_BRIDGE_VERSION__", APP_VERSION);
}
