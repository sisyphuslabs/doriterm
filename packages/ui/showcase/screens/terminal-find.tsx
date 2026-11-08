import { FindBar, type TerminalLine } from "../../src/index.ts";
import { BoardFrame, StateSection, TerminalCrop } from "./frames.tsx";
import { MobileTerminal } from "./mobile.tsx";

const LOG: readonly TerminalLine[] = [
  [{ text: "$ ", color: 8 }, { text: "bun run build" }],
  [
    { text: "  compiled ", color: 8 },
    { text: "packages/ui", color: 4 },
  ],
  [{ text: "  " }, { text: "warning", mark: "match", color: 3 }, { text: ": unused export in tokens.ts", color: 3 }],
  [
    { text: "  compiled ", color: 8 },
    { text: "apps/web", color: 4 },
  ],
  [{ text: "  " }, { text: "warning", mark: "current", color: 3 }, { text: ": chunk larger than 500 kB", color: 3 }],
  [
    { text: "  compiled ", color: 8 },
    { text: "apps/desktop", color: 4 },
  ],
  [{ text: "  done in 4.2s, 2 " }, { text: "warning", mark: "match" }, { text: "s" }],
  [{ text: "$ ", color: 8 }],
];

const bar = (query: string, result: { current: number | null; total: number } | null) => (
  <FindBar
    query={query}
    onQueryChange={() => undefined}
    result={result}
    onNext={() => undefined}
    onPrevious={() => undefined}
    onClose={() => undefined}
    className="w-[22rem] max-w-full"
  />
);

const STATES = [
  { label: "Typing: matches highlighted, the current one stronger", overlay: bar("warning", { current: 1, total: 3 }) },
  { label: "No matches", overlay: bar("segfault", { current: null, total: 0 }) },
  { label: "Opened with nothing typed", overlay: bar("", null) },
];

/** #732: herdr-app's terminal.search, a find bar over the focused terminal for its screen and scrollback. */
export function TerminalFindScreen() {
  return (
    <main className="min-h-dvh bg-background">
      <div data-density="coarse" className="h-[844px] md:hidden">
        <MobileTerminal lines={LOG} overlay={bar("warning", { current: 1, total: 3 })} />
      </div>
      <div className="hidden p-6 md:block">
        <BoardFrame label="Find in terminal (Cmd+F, Ctrl+Shift+F elsewhere)">
          {STATES.map((state) => (
            <StateSection key={state.label} label={state.label}>
              <div className="relative">
                <TerminalCrop lines={LOG} className="h-64" />
                <div className="absolute top-2 right-3">{state.overlay}</div>
              </div>
            </StateSection>
          ))}
        </BoardFrame>
      </div>
    </main>
  );
}
