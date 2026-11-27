/** The input of the focused pane's terminal, else any shown terminal's. */
export function terminalInput(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[data-focused="true"] [data-terminal] textarea') ??
    document.querySelector<HTMLElement>("[data-terminal] textarea")
  );
}

export function sidebarElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('aside[aria-label="Workspace"]');
}

/** The sidebar list's Tab stop: the selected row, else the first list's stop, else the first control. */
export function sidebarStop(): HTMLElement | null {
  const aside = sidebarElement();
  return (
    aside?.querySelector<HTMLElement>('[data-roving-lists] button[aria-current="true"]') ??
    aside?.querySelector<HTMLElement>('[data-roving-lists] button[tabindex="0"]') ??
    aside?.querySelector<HTMLElement>("button, a[href]") ??
    null
  );
}
