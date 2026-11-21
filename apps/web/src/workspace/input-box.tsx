import { SendHorizontal } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, cn } from "@doriface/ui";
import { freshSlash, matchCommands, namingCommand } from "./omo-commands.ts";
import { optionId, SlashList } from "./slash-list.tsx";
import type { OmoCommands } from "./use-omo-commands.ts";

export interface InputBoxProps {
  /** Writes the text and presses Return: one line for the program, as the field shows it. */
  readonly onSend: (text: string) => void;
  /** Whose draft the field shows: an unsent line is kept per terminal while the keyboard is down. */
  readonly draftKey: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** OmO's commands, when the terminal runs OmO: a `/` typed into the empty field lists them to pick from (#2658). */
  readonly slash?: OmoCommands | null;
}

/** Unsent lines by terminal, kept for this page's life: closing the keyboard unmounts the field, not the draft. */
const drafts = new Map<string, string>();

/** The tallest the field grows as it wraps, about four lines; past that it scrolls. */
const MAX_HEIGHT_PX = 112;

/**
 * The phone's line into the terminal (#666): a text field takes what is typed, so the phone's own keyboard does the
 * input method, autocorrect and Hangul composition in a real field, and Send writes the line and presses Return. The
 * field sends nothing before Send, which is the difference from typing in the terminal itself. It wraps and grows, so
 * the whole line is in view while it is written (#949). On the phone it is the keys bar's top row, Send at its end, typing
 * or not (#1551).
 */
export function InputBox({ onSend, draftKey, className, style, slash = null }: InputBoxProps) {
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
  const listId = useId();
  // The line Escape put the list away for; typing on brings it back.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const listing = slash !== null && focused && namingCommand(text) && dismissed !== text;
  const matches = listing && slash.list.kind === "ready" ? matchCommands(slash.list.commands, text) : [];
  const chosen = matches[Math.min(pick, matches.length - 1)];
  const type = (next: string): void => {
    // Each new `/` asks for the list: one that failed (OmO slow to start, a machine that dropped) or has grown stale is
    // read again, a fresh one is kept.
    if (slash !== null && freshSlash(text, next)) slash.want();
    setText(next);
    setPick(0);
    setDismissed(null);
  };
  // Asked for when the list is first wanted, which may be before OmO took the terminal's foreground (a `/` typed as it
  // starts): the field reads the commands once it knows the program.
  const wantsList = listing && slash.list.kind === "idle";
  const want = slash?.want;
  useEffect(() => {
    if (wantsList) want?.();
  }, [wantsList, want]);
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
    const line = element?.value ?? text;
    if (line.trim() === "") return;
    onSend(line);
    setText("");
  };
  // Enter sends; Shift+Enter is a line of its own. A key that is still composing a Hangul syllable belongs to the
  // input method, which commits on it, and never to Send.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (listing && listKey(event)) return;
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };
  // Picking a command runs it: the field sends a whole line with Return, and a command that takes words is typed out
  // with a space, which puts the list away, then sent as any line is.
  const run = (name: string): void => {
    onSend(`/${name}`);
    setText("");
  };
  const listKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key === "Escape") setDismissed(text);
    else if (event.key === "ArrowDown" && matches.length > 0) setPick((pick + 1) % matches.length);
    else if (event.key === "ArrowUp" && matches.length > 0) setPick((pick - 1 + matches.length) % matches.length);
    else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && chosen !== undefined)
      run(chosen.name);
    else return false;
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  // The field and Send keep the 0.5rem the phone chrome leaves between two pressable controls (the round buttons'
  // slot), so a thumb at the field's end does not land on Send (#1506).
  return (
    <div className={cn("relative flex items-end gap-2 px-1.5 py-1", className)} style={style}>
      {listing ? (
        <SlashList
          id={listId}
          list={slash.list}
          matches={matches}
          typed={text}
          active={chosen === undefined ? -1 : matches.indexOf(chosen)}
          onActive={setPick}
          onPick={(command) => run(command.name)}
        />
      ) : null}
      <textarea
        ref={field}
        rows={1}
        enterKeyHint="send"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={text}
        aria-label="Type into the terminal"
        {...(slash === null
          ? {}
          : {
              role: "combobox",
              "aria-autocomplete": "list" as const,
              "aria-expanded": listing,
              "aria-controls": matches.length > 0 ? listId : undefined,
              "aria-activedescendant": chosen === undefined ? undefined : optionId(listId, matches.indexOf(chosen)),
            })}
        onChange={(event) => type(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        className={cn(
          "min-h-11 min-w-0 flex-1 resize-none border border-input bg-chrome/95 px-3.5 py-2.5 font-mono text-base leading-6 wrap-break-word whitespace-pre-wrap text-foreground",
          "shadow-lg outline-none backdrop-blur-md placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring",
          active ? "rounded-[1.375rem]" : "h-11 rounded-full",
        )}
        placeholder="Type"
      />
      <Button
        type="button"
        variant="primary"
        aria-label="Send"
        disabled={text.trim() === ""}
        // A press that moved focus to this button would put the phone's keyboard down mid-sentence.
        onMouseDown={(event) => event.preventDefault()}
        onClick={send}
        className="size-11 shrink-0 rounded-full p-0"
      >
        <SendHorizontal aria-hidden className="size-5" />
      </Button>
    </div>
  );
}
