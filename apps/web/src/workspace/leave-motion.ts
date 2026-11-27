import { type RefObject, useLayoutEffect, useRef } from "react";

/** A motion's duration (ms) and curve, as a token pair in tokens.css names them (motion-tokens.test.ts). */
export interface MotionTiming {
  readonly duration: number;
  readonly easing: string;
}

/** How a region leaves: its picture plays these keyframes once, then goes (DESIGN.md 6). */
export interface LeaveMotion {
  readonly keyframes: Keyframe[];
  readonly timing: MotionTiming;
}

/** DESIGN.md 6: a panel or sheet leaves over --duration-sheet-out on --ease-exit (motion-tokens.test.ts). */
export const SHEET_OUT: MotionTiming = { duration: 200, easing: "cubic-bezier(0.3, 0, 0.8, 0.15)" };

/** Attributes that name a live thing (a terminal, a landmark, an element to find): a picture of the screen keeps none. */
const IDENTITY = [
  "id",
  "role",
  "aria-label",
  "aria-labelledby",
  "aria-modal",
  "data-terminal",
  "data-browsing",
  "data-slot",
  "data-sidebar-drawer",
  "data-settings-sheet",
  "data-settings-dialog",
] as const;

/** A picture of a region, and where each of its scrolled elements stood: a copy of the DOM keeps no scroll offsets. */
interface Picture {
  readonly ghost: HTMLElement;
  /** By the element's place in the region's document order (the region first): its scrollTop and scrollLeft. */
  readonly scrolled: readonly (readonly [place: number, top: number, left: number])[];
}

const inOrder = (root: HTMLElement): Element[] => [root, ...root.querySelectorAll("*")];

/**
 * A still picture of `region` at `box`: no names, no roles, no input, nothing a query for the live region can find.
 * `data-leaving` keeps every transition in it off (base.css), so nothing in it eases in from @starting-style again.
 */
function pictureOf(region: HTMLElement, box: DOMRect): Picture | null {
  const ghost = region.cloneNode(true);
  if (!(ghost instanceof HTMLElement)) return null;
  const scrolled = inOrder(region).flatMap((element, place) =>
    element.scrollTop === 0 && element.scrollLeft === 0
      ? []
      : [[place, element.scrollTop, element.scrollLeft] as const],
  );
  for (const element of inOrder(ghost)) for (const name of IDENTITY) element.removeAttribute(name);
  ghost.setAttribute("aria-hidden", "true");
  ghost.setAttribute("inert", "");
  ghost.dataset["leaving"] = "";
  ghost.style.cssText += `;position:fixed;inset:auto;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;margin:0;z-index:40;pointer-events:none;`;
  return { ghost, scrolled };
}

/**
 * Plays a picture already taken: inserted over the page, each scrolled element put back where it stood (before the motion
 * starts, so no frame shows it at the top), and removed when its motion ends or its time is up.
 */
function play({ ghost, scrolled }: Picture, { keyframes, timing }: LeaveMotion): void {
  document.body.append(ghost);
  const elements = inOrder(ghost);
  for (const [place, top, left] of scrolled) elements[place]?.scrollTo({ top, left, behavior: "instant" });
  const motion = ghost.animate(keyframes, { ...timing, fill: "forwards" });
  const remove = (): void => ghost.remove();
  motion.finished.then(remove, remove);
  // A page whose frames are not drawn (a background tab, a starved renderer) may hold the motion's end back; the picture
  // goes when the motion's own time is up either way.
  setTimeout(remove, timing.duration + 100);
}

export const reducedMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Takes a still copy of `region` where it stands now; the call it returns lays it over the page and plays `motion` on
 * it, so a region the page drops in between seems to leave instead of vanishing. The copy takes no input.
 */
export function pictureToLeave(region: HTMLElement, motion: LeaveMotion): () => void {
  const picture = pictureOf(region, region.getBoundingClientRect());
  return () => {
    if (picture !== null) play(picture, motion);
  };
}

/**
 * When the element in `ref` is unmounted and `plays()` still says so, its picture leaves with `motion`. The picture is
 * taken as React unmounts the component, before the element leaves the page, and played only once the element is really
 * gone: a StrictMode remount, which keeps the element, plays nothing. Under reduced motion nothing leaves: the region
 * goes at once (DESIGN.md 6, Leaving).
 */
export function useLeaveMotion(
  ref: RefObject<HTMLElement | null>,
  motion: LeaveMotion,
  plays: () => boolean = () => true,
): void {
  const latest = useRef({ motion, plays });
  latest.current = { motion, plays };
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (element === null || !element.isConnected || reducedMotion()) return;
      const picture = pictureOf(element, element.getBoundingClientRect());
      if (picture === null) return;
      queueMicrotask(() => {
        if (element.isConnected || !latest.current.plays()) return;
        play(picture, latest.current.motion);
      });
    };
  }, [ref]);
}
