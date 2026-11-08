import { DialogPanel, ShortcutList, type ShortcutGroup } from "../../src/index.ts";
import { ShellFrame } from "./shell.tsx";

const GROUPS: readonly ShortcutGroup[] = [
  {
    title: "App",
    rows: [
      { id: "tab.new", label: "New tab", chords: [["⌘", "T"]] },
      {
        id: "tab.close",
        label: "Close tab",
        chords: [
          ["⌘", "W"],
          ["⌘", "⌥", "W"],
        ],
      },
      { id: "pane.split:right", label: "Split right", chords: [["⌘", "D"]] },
      { id: "pane.split:down", label: "Split down", chords: [["⌘", "⇧", "D"]] },
      { id: "app.palette", label: "Command palette", chords: [["⌃", "⌥", "K"]] },
      { id: "app.settings", label: "Open settings", chords: [["⌘", ","]] },
      {
        id: "app.help",
        label: "Keyboard shortcuts",
        chords: [
          ["⌘", "/"],
          ["⌘", "⇧", "/"],
        ],
      },
    ],
  },
  {
    title: "Terminal",
    rows: [
      { id: "terminal.copy", label: "Copy", chords: [["⌘", "C"]] },
      { id: "terminal.paste", label: "Paste", chords: [["⌘", "V"]] },
      { id: "terminal.clear", label: "Clear screen", chords: [["⌘", "K"]] },
      { id: "send:\u0015", label: "Send ^U (delete to line start)", chords: [["⌘", "⌫"]] },
    ],
  },
];

/** The shortcuts dialog (app.help) over the dimmed workspace; one binding is a person's own (Command palette). */
export function ShortcutsScreen() {
  return (
    <ShellFrame>
      <div className="absolute inset-0 bg-black/40" aria-hidden />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <DialogPanel
          title="Keyboard shortcuts"
          description="Your keys as they are set now. Change them in Settings > Keybindings."
          className="w-[min(36rem,calc(100%-2rem))]"
        >
          <ShortcutList groups={GROUPS} />
        </DialogPanel>
      </div>
    </ShellFrame>
  );
}
