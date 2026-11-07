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

export async function pruneIconFonts(
  cache: Pick<Cache, "keys" | "delete">,
  iconFonts: ReadonlySet<string>,
): Promise<number> {
  const stale = (await cache.keys()).filter((request) => !iconFonts.has(new URL(request.url).pathname));
  await Promise.all(stale.map((request) => cache.delete(request)));
  return stale.length;
}
