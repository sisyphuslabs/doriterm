import { cn, IconButton, StatusChip, StatusIndicator } from "@doriface/ui";
import { Maximize2 } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { agentStatus } from "./attention.ts";
import { type Session, terminalTitle } from "./model.ts";
import { clampRatio, DEFAULT_RATIO, splitBeside, storedRatio, storeRatio } from "./split-focus.ts";
import { useShown } from "./use-shown.ts";

export interface SplitFocusViewProps {
  /** The two panes shown, in the tab's order. */
  readonly pair: readonly [Session, Session];
  /** The pane in focus: its half takes the keys bar, dictation and the keyboard. */
  readonly focused: string;
  /** Where this device keeps the split's ratio: the tab, as its panes name it. */
  readonly ratioKey: string;
  /** One half's terminal, as the phone draws it; `focused` says whether it is the half in focus. */
  readonly terminal: (session: Session, focused: boolean) => ReactNode;
  /** A tap on the other half moves the focus there. */
  readonly onFocus: (address: string) => void;
  /** Fills the screen with one pane; Back returns to the split. */
  readonly onExpand: (address: string) => void;
}

const STEP = 0.05;

/**
 * A phone's split focus (design proposal section 6): two real terminals of one split tab, stacked in portrait and side
 * by side in landscape, each with its own size (D2). One tap moves the focus; the half out of focus steps back.
 */
export function SplitFocusView({ pair, focused, ratioKey, terminal, onFocus, onExpand }: SplitFocusViewProps) {
  const box = useRef<HTMLDivElement>(null);
  const [beside, setBeside] = useState(false);
  const [ratio, setRatio] = useState(() => storedRatio(ratioKey));
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return undefined;
    const measure = (): void => setBeside(splitBeside(element.clientWidth, element.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const settle = (next: number): void => {
    const clamped = clampRatio(next);
    setRatio(clamped);
    storeRatio(ratioKey, clamped);
  };
  const [first, second] = pair;
  return (
    <div
      ref={box}
      data-split-focus={beside ? "beside" : "stacked"}
      className={cn("flex min-h-0 flex-1 gap-0 p-1.5", beside ? "flex-row" : "flex-col")}
    >
      <Half
        session={first}
        share={ratio}
        focused={first.address === focused}
        terminal={terminal}
        onFocus={onFocus}
        onExpand={onExpand}
      />
      <Handle beside={beside} ratio={ratio} box={box} onMove={setRatio} onSettle={settle} />
      <Half
        session={second}
        share={1 - ratio}
        focused={second.address === focused}
        terminal={terminal}
        onFocus={onFocus}
        onExpand={onExpand}
      />
    </div>
  );
}

function Half(props: {
  readonly session: Session;
  readonly share: number;
  readonly focused: boolean;
  readonly terminal: (session: Session, focused: boolean) => ReactNode;
  readonly onFocus: (address: string) => void;
  readonly onExpand: (address: string) => void;
}) {
  const { session, share, focused, terminal, onFocus, onExpand } = props;
  const [now = session] = useShown([session]);
  const title = terminalTitle(now);
  const status = agentStatus(session);
  // The half out of focus takes no touch of its own: the first tap only moves the focus, raising no keyboard.
  const take = (event: PointerEvent<HTMLDivElement>): void => {
    if (focused || (event.target instanceof Element && event.target.closest("button") !== null)) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus(session.address);
  };
  return (
    <section
      aria-label={title}
      data-split-half={session.address}
      data-focused={focused}
      style={{ flexGrow: share, flexBasis: 0 }}
      onPointerDownCapture={take}
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border bg-card",
        focused ? "border-ring" : "border-border",
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-chrome pr-0.5 pl-2.5">
        <StatusIndicator status={status} className="size-3 shrink-0" />
        <button
          type="button"
          aria-pressed={focused}
          aria-label={focused ? `${title}, in focus` : `Focus ${title}`}
          onClick={() => onFocus(session.address)}
          className={cn(
            "min-w-0 flex-1 truncate text-left text-sm",
            focused ? "font-semibold text-foreground" : "text-muted-foreground",
          )}
        >
          {title}
        </button>
        {status === "blocked" ? <StatusChip status={status} /> : null}
        <IconButton
          label={`Fill the screen with ${title}`}
          icon={<Maximize2 />}
          size="sm"
          onClick={() => onExpand(session.address)}
        />
      </div>
      <div className={cn("relative flex min-h-0 flex-1 flex-col", focused ? null : "opacity-72")}>
        {terminal(session, focused)}
      </div>
    </section>
  );
}

function Handle(props: {
  readonly beside: boolean;
  readonly ratio: number;
  readonly box: React.RefObject<HTMLDivElement | null>;
  readonly onMove: (ratio: number) => void;
  readonly onSettle: (ratio: number) => void;
}) {
  const { beside, ratio, box, onMove, onSettle } = props;
  const at = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = box.current?.getBoundingClientRect();
    if (rect === undefined) return ratio;
    return clampRatio(beside ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height);
  };
  const key = (event: KeyboardEvent<HTMLDivElement>): void => {
    const back = beside ? "ArrowLeft" : "ArrowUp";
    const on = beside ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== on) return;
    event.preventDefault();
    onSettle(ratio + (event.key === on ? STEP : -STEP));
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="Resize the split"
      aria-orientation={beside ? "vertical" : "horizontal"}
      aria-valuemin={30}
      aria-valuemax={70}
      aria-valuenow={Math.round(ratio * 100)}
      onKeyDown={key}
      onDoubleClick={() => onSettle(DEFAULT_RATIO)}
      onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onMove(at(event));
      }}
      onPointerUp={(event) => onSettle(at(event))}
      className={cn(
        "flex shrink-0 touch-none items-center justify-center",
        beside ? "w-3 cursor-col-resize" : "h-3 cursor-row-resize",
      )}
    >
      <span aria-hidden className={cn("rounded-full bg-border", beside ? "h-8 w-1" : "h-1 w-8")} />
    </div>
  );
}
