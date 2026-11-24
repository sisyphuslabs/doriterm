import { flushSync } from "react-dom";

interface ViewTransitionLike {
  readonly finished: Promise<unknown>;
}

type StartViewTransition = (
  callbackOrOptions: (() => void) | { readonly update: () => void; readonly types: readonly string[] },
) => ViewTransitionLike;

/**
 * Slides the leaving phone screen off to the trailing edge on Back via View Transitions, when supported on a coarse
 * pointer without reduced motion; elsewhere runs `go` at once.
 */
export function backWithMotion(go: () => void): void {
  const start = (document as Document & { readonly startViewTransition?: StartViewTransition }).startViewTransition;
  if (
    typeof start !== "function" ||
    !matchMedia("(pointer: coarse)").matches ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    go();
    return;
  }
  const update = () => {
    flushSync(go);
  };
  try {
    start.call(document, { update, types: ["phone-back"] });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const root = document.documentElement;
    root.dataset["backMotion"] = "";
    const clear = () => {
      delete root.dataset["backMotion"];
    };
    try {
      const transition = start.call(document, update);
      void transition.finished.then(clear, clear);
    } catch (fallbackError) {
      clear();
      throw fallbackError;
    }
  }
}
