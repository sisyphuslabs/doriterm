import type { WTerm } from "@wterm/react";
import { useLayoutEffect } from "react";

/**
 * On a touch screen a focus in the terminal's field raises the soft keyboard, so there it comes up only when the person
 * asks for it (#1375). Until `asked`, the field asks for no keyboard (inputmode none) should anything focus it, and a
 * tap is not a reason to focus it: wterm's click-to-focus is cancelled, which leaves selection, links and mouse
 * reporting alone, and the field over the cursor's cell lets a tap through to the cell instead of taking it. Once
 * asked, a tap on the terminal keeps the keyboard where it is rather than blurring the field on its press. Unset
 * `asked` (a fine pointer) leaves the field as wterm has it. A layout effect, so a press that asks (flushSync, then
 * focus) focuses a field that already asks for a keyboard.
 */
export function useKeyboardAsk(wt: WTerm | null, asked: boolean | undefined): void {
  useLayoutEffect(() => {
    if (wt === null || asked === undefined) return undefined;
    const element = wt.element;
    const field = element.querySelector("textarea");
    field?.setAttribute("inputmode", asked ? "text" : "none");
    field?.style.setProperty("pointer-events", asked ? null : "none");
    if (asked) {
      const keep = (event: MouseEvent): void => {
        if (element.contains(element.ownerDocument.activeElement)) event.preventDefault();
      };
      element.addEventListener("mousedown", keep);
      return () => element.removeEventListener("mousedown", keep);
    }
    const noFocus = (event: MouseEvent): void => event.preventDefault();
    element.addEventListener("click", noFocus, { capture: true });
    return () => element.removeEventListener("click", noFocus, { capture: true });
  }, [wt, asked]);
}
