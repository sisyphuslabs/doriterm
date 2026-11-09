/**
 * App actions a focused terminal program keeps: their key is not taken from the program, as a text field keeps the keys
 * that edit text (`text-field-keys.ts`). A space's number chord is Ctrl and a digit on macOS and Alt and a digit
 * elsewhere (herdr-app's), both keys a shell or a TUI reads (a control key, a Meta digit), so it acts while the keyboard
 * is outside the terminal (the sidebar, the tab strip, the palette, the Shell menu) and reaches the program otherwise. Space's cycle chords keep a
 * modifier the app owns, so they work from a terminal too.
 */
export const TERMINAL_KEEPS: ReadonlySet<string> = new Set(
  Array.from({ length: 9 }, (_, index) => `space.select:${index + 1}`),
);
