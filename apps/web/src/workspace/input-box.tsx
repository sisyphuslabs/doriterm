import { CornerDownLeft } from "lucide-react";
import { type CSSProperties, type ReactNode, type Ref, useLayoutEffect, useRef, useState } from "react";
import { Button, cn } from "@doriface/ui";

export interface InputBoxProps {
  /** Writes the text and presses Return: one line for the program, as the field shows it. */
  readonly onSend: (text: string) => void;
  /** Whose draft the field shows: an unsent line is kept per terminal while the keyboard is down. */
  readonly draftKey: string;
  /**
   * The field itself, for the card's toggle to focus inside its own tap: iOS raises the keyboard only for a focus made
   * while the tap is handled, never for one made as the card mounts after it.
   */
  readonly fieldRef?: Ref<HTMLTextAreaElement>;
  /** Drawn just before Enter, as the Herdr app's card holds its mic there. */
  readonly accessory?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

/** Unsent lines by terminal, kept for this page's life: closing the keyboard unmounts the field, not the draft. */
const drafts = new Map<string, string>();

/** The tallest the field grows as it wraps, about four lines; past that it scrolls. */
const MAX_HEIGHT_PX = 112;

/**
 * The phone's line into the terminal (#666): a text field takes what is typed, so the phone's own keyboard does the
 * input method, autocorrect and Hangul composition in a real field, and Send writes the line and presses Return. The
 * field sends nothing before Send, which is the difference from typing in the terminal itself; Enter only starts a new
 * line (#2766). It wraps and grows, so the whole draft is in view while it is written (#949). On the phone it lives in
 * the input card over the keys row, which its toggle opens (#2778).
 */
export function InputBox({ onSend, draftKey, fieldRef, accessory, className, style }: InputBoxProps) {
  const [text, setTextState] = useState(() => drafts.get(draftKey) ?? "");
  const [focused, setFocused] = useState(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  const setText = (next: string): void => {
    if (next === "") drafts.delete(draftKey);
    else drafts.set(draftKey, next);
    setTextState(next);
  };
  const active = focused || text !== "";
  // The field in use is as tall as its wrapped text, up to MAX_HEIGHT_PX; an idle field keeps its pill height (h-11).
  useLayoutEffect(() => {
    const element = field.current;
    if (element === null) return;
    if (!active) {
      element.style.height = "";
      return;
    }
    element.style.height = "auto";
    element.style.height = `${Math.min(MAX_HEIGHT_PX, element.scrollHeight + element.offsetHeight - element.clientHeight)}px`;
  }, [text, active]);
  const send = (): void => {
    const element = field.current;
    // A syllable still composing is part of the line as shown; ending the composition first keeps the input method
    // from putting it back into the emptied field. The field keeps the focus, so the keyboard stays up.
    if (element !== null && composing.current && document.activeElement === element) {
      element.blur();
      element.focus();
    }
    // Send ends the line once: line breaks left at the end of the field are not sent as Returns of their own, which would
    // answer the next prompt (#2870).
    const line = (element?.value ?? text).replace(/[\r\n]+$/, "");
    // With nothing written Enter is still Enter: it presses Return alone, as the Herdr app's card does. A line of spaces is
    // sent as written; a pager or a prompt reads them.
    onSend(line);
    setText("");
  };
  // As the Herdr app's card: the field takes the whole width, and under it the mic and Enter sit at the end. The rows and
  // the two buttons keep the 0.5rem the phone chrome leaves between two pressable controls (#1506).
  return (
    <div className={cn("flex flex-col gap-2 px-1.5 py-1", className)} style={style}>
      {/* A row of its own, so the field's height is its cross size: the pill's h-11, or what the wrap sets. */}
      <div className="flex items-end">
        <textarea
          ref={(node) => {
            field.current = node;
            if (typeof fieldRef === "function") return fieldRef(node);
            if (fieldRef !== null && fieldRef !== undefined) fieldRef.current = node;
            return undefined;
          }}
          rows={1}
          // Enter starts a new line, on the phone's keyboard and a hardware one; only Send sends (#2766).
          enterKeyHint="enter"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={text}
          aria-label="Type into the terminal"
          onChange={(event) => setText(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          className={cn(
            "min-h-11 min-w-0 flex-1 resize-none border border-input bg-chrome/95 px-3.5 font-mono text-base leading-6 wrap-break-word whitespace-pre-wrap text-foreground",
            "shadow-lg outline-none backdrop-blur-md placeholder:text-muted-foreground focus:border-ring/75 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring",
            // The idle pill fits its one line exactly: py-2.5 leaves the 24 px line 2 px taller than the h-11 pill's
            // content box, and a scrollable textarea draws a scrollbar bar inside it (#2670).
            active ? "rounded-[1.375rem] py-2.5" : "h-11 rounded-full py-2",
          )}
          placeholder="Type"
        />
      </div>
      <div data-slot="input-actions" className="flex items-center justify-end gap-2">
        {/* As Send: a press here keeps the field's focus, so the keyboard stays up and the card does not move under the
            finger before the press ends (the mic's tap was lost to that move). */}
        <span className="contents" onMouseDown={(event) => event.preventDefault()}>
          {accessory}
        </span>
        <Button
          type="button"
          variant="primary"
          aria-label="Send"
          // A press that moved focus to this button would put the phone's keyboard down mid-sentence.
          onMouseDown={(event) => event.preventDefault()}
          onClick={send}
          className="size-11 shrink-0 rounded-full p-0"
        >
          <CornerDownLeft aria-hidden className="size-5" />
        </Button>
      </div>
    </div>
  );
}
