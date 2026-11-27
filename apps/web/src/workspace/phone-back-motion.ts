/** DESIGN.md 6: Back slides the leaving screen off over --duration-back on --ease-exit (motion-tokens.test.ts). */
export const BACK_MOTION: KeyframeAnimationOptions = { duration: 200, easing: "cubic-bezier(0.3, 0, 0.8, 0.15)" };

/** Attributes that name a live thing (a terminal, a landmark, an element to find): a picture of the screen keeps none. */
const IDENTITY = [
  "id",
  "role",
  "aria-label",
  "aria-labelledby",
  "data-terminal",
  "data-browsing",
  "data-slot",
] as const;

/** A still picture of `screen`: no names, no roles, no input, nothing a query for the live screen can find. */
function pictureOf(screen: HTMLElement): HTMLElement | null {
  const ghost = screen.cloneNode(true);
  if (!(ghost instanceof HTMLElement)) return null;
  for (const element of [ghost, ...ghost.querySelectorAll("*")])
    for (const name of IDENTITY) element.removeAttribute(name);
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.dataset["backGhost"] = "";
  return ghost;
}

const moves = (): boolean =>
  matchMedia("(pointer: coarse)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Goes back at once, as before (the history pops in this same call, so a double tap still pops once, #2229, and the
 * screen underneath restores its scroll on its first frame, #1553), and slides a still copy of the screen that was left
 * off to the trailing edge over it. The copy takes no input and is removed when the slide ends. `from` is any element
 * inside the leaving screen; its `.motion-arrive` root is the screen. Without touch, or under reduced motion, Back is
 * only the pop.
 */
export function backWithMotion(from: Element | null, go: () => void): void {
  const screen = from?.closest(".motion-arrive");
  if (!(screen instanceof HTMLElement) || !moves()) return go();
  const box = screen.getBoundingClientRect();
  const ghost = pictureOf(screen);
  if (ghost === null) return go();
  ghost.style.cssText += `;position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;margin:0;z-index:40;pointer-events:none;`;
  go();
  screen.ownerDocument.body.append(ghost);
  const slide = ghost.animate([{ transform: "translateX(0)" }, { transform: "translateX(100%)" }], {
    ...BACK_MOTION,
    fill: "forwards",
  });
  const remove = (): void => ghost.remove();
  slide.finished.then(remove, remove);
  // A page whose frames are not drawn (a background tab, a starved renderer) may hold the slide's end back; the picture
  // goes when the slide's own time is up either way.
  setTimeout(remove, Number(BACK_MOTION.duration) + 100);
}
