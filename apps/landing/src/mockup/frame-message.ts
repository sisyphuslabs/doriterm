/** The landing names its pinned theme "light" or "dark"; the app's presets for those are Day and Night. */
const THEMES: Readonly<Record<string, string>> = { light: "day", dark: "night" };

/** Pins the mockup to the landing's theme, or lets it follow prefers-color-scheme (null or an unknown name). */
export function applyTheme(root: Pick<HTMLElement, "dataset">, choice: string | null): void {
  const theme = choice === null ? undefined : THEMES[choice];
  if (theme === undefined) delete root.dataset["theme"];
  else root.dataset["theme"] = theme;
}

/**
 * Applies what the landing page posts a live mockup (main.js postTheme, postMotion) to the mockup's root element. The
 * landing's motion toggle pauses every loop on the page, these frames' spinners included (#1179, WCAG 2.2.2):
 * mockup.css holds every animation under data-motion="paused".
 */
export function applyFrameMessage(root: Pick<HTMLElement, "dataset">, data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  if ("theme" in data) {
    const { theme } = data as { readonly theme: unknown };
    applyTheme(root, typeof theme === "string" ? theme : null);
  }
  if ("motionPaused" in data) {
    if (data.motionPaused === true) root.dataset["motion"] = "paused";
    else delete root.dataset["motion"];
  }
}
