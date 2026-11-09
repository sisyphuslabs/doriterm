/**
 * App actions a focused terminal program keeps: their key is not taken from the program, as a text field keeps the keys
 * that edit text (`text-field-keys.ts`). A space's number chord is Alt and a digit on Linux and Windows (herdr-app's), a
 * Meta digit a shell or a TUI reads, so it acts while the keyboard is outside the terminal (the sidebar, the tab strip,
 * the palette, the Shell menu) and reaches the program otherwise. On a Mac it is Cmd+Alt and a digit, beside the cycle
 * chords; Cmd is a modifier the app owns, so those work from a terminal too, as any chord with Cmd does.
 */
export const TERMINAL_KEEPS: ReadonlySet<string> = new Set(
  Array.from({ length: 9 }, (_, index) => `space.select:${index + 1}`),
);

/** True when a focused terminal program keeps `trigger`, bound to `action`: a kept action on a chord without Cmd. */
export function terminalKeeps(action: string, trigger: string): boolean {
  return TERMINAL_KEEPS.has(action) && !trigger.split("+").includes("super");
}
