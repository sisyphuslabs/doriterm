/**
 * The Nerd Font icon face (1.2 MB) is left out of the precache: the service worker fetches it the first time a page
 * draws an icon and keeps it in its own cache. Its name carries its contents' hash, so a release that changes it adds a
 * new name; the worker of each build drops the copies its build does not use (#967).
 */
export const ICON_FONT_CACHE = "doriterm-fonts-v1";

const ICON_FONT = /\/symbols-nerd-font-mono-[^/]*\.woff2$/;

export const isIconFont = (url: URL): boolean => ICON_FONT.test(url.pathname);

type ManifestEntry = string | { readonly url: string; readonly revision: string | null };

/** The build's precache list without the icon font, and the icon font paths the build uses, resolved against `base`. */
export function splitIconFonts(
  manifest: readonly ManifestEntry[],
  base: string,
): { readonly precache: ManifestEntry[]; readonly iconFonts: ReadonlySet<string> } {
  const precache: ManifestEntry[] = [];
  const iconFonts = new Set<string>();
  for (const entry of manifest) {
    const url = new URL(typeof entry === "string" ? entry : entry.url, base);
    if (isIconFont(url)) iconFonts.add(url.pathname);
    else precache.push(entry);
  }
  return { precache, iconFonts };
}

/**
 * Whether the icon font at `url` is this build's own copy, the only kind the worker stores. An earlier release's name,
 * still asked for by a page left open on the old build, is answered from the network and not kept (#1166).
 */
export function keepsIconFont(url: URL, iconFonts: ReadonlySet<string>): boolean {
  return iconFonts.has(url.pathname);
}

/**
 * Deletes the copies the build does not use and keeps its own. A build that names no icon font may have lost it from
 * its precache list (a size limit or a glob change), not decided to keep none, so it deletes nothing: the copy that is
 * there survives the release instead of being downloaded again. `null` reports that skip, so the worker can say so
 * (#1167).
 */
export async function pruneIconFonts(
  cache: Pick<Cache, "keys" | "delete">,
  iconFonts: ReadonlySet<string>,
): Promise<number | null> {
  if (iconFonts.size === 0) return null;
  const stale = (await cache.keys()).filter((request) => !iconFonts.has(new URL(request.url).pathname));
  await Promise.all(stale.map((request) => cache.delete(request)));
  return stale.length;
}
