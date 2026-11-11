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
 * mockup.css starts every animation that appears under data-motion="paused" paused, and {@link holdMotion} pauses the
 * ones already running.
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

/**
 * Pauses every animation in the mockup through the Web Animations API, or sets them going again. A CSS play state alone
 * does not hold a spinner, whose phase sync takes it over from CSS; a paused spinner keeps its pause (spinner.tsx).
 * Resumed loops restart on the document timeline's zero, as Spinner sets them, so they turn in step again.
 */
export function holdMotion(view: Pick<Document, "getAnimations">, paused: boolean): void {
  for (const animation of view.getAnimations()) {
    if (paused) animation.pause();
    else if (animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY) animation.startTime = 0;
    // play() would rewind a finished animation; only a held one goes on from where it stood.
    else if (animation.playState === "paused") animation.play();
  }
}
