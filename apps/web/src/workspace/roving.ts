/**
 * Roving focus over the sidebar lists: every `section` is one list and one Tab stop. A row is a button that is a
 * direct child of the section, or the first button of a direct child (a machine row); the other buttons of that child
 * are the row's actions, reached with ArrowRight instead of Tab. A machine row that a reorderable list wraps to drag it
 * (`data-machine-row`, #140) holds that child one level down. A row that is disabled (a machine with nothing to
 * open) is still a stop, so its actions stay reachable; it stays focusable through aria-disabled instead of disabled.
 * ArrowUp, ArrowDown, Home and End move inside the focused list; Tab moves to the next list.
 */
const STOP = "data-roving-stop";

const isButton = (node: unknown): node is HTMLButtonElement => node instanceof HTMLButtonElement;

function rowOf(child: Element): HTMLButtonElement | undefined {
  if (isButton(child)) return child;
  const item = child.hasAttribute("data-machine-row") ? child.firstElementChild : child;
  const first = item?.firstElementChild;
  return item?.tagName === "DIV" && isButton(first) ? first : undefined;
}

export function rowsOf(section: Element): HTMLButtonElement[] {
  return [...section.children].flatMap((child) => rowOf(child) ?? []);
}

function actionsOf(row: HTMLButtonElement): HTMLButtonElement[] {
  const parent = row.parentElement;
  if (parent === null || parent.tagName === "SECTION") return [];
  return [...parent.querySelectorAll("button")].filter((button) => button !== row);
}

/** Keeps one row per list in the Tab order: the last one focused, else the selected one, else the first. */
export function syncStops(root: Element): void {
  for (const section of root.querySelectorAll("section")) {
    const rows = rowsOf(section);
    const stop =
      rows.find((row) => row.hasAttribute(STOP)) ??
      rows.find((row) => row.getAttribute("aria-current") === "true") ??
      rows[0];
    for (const row of rows) {
      row.tabIndex = row === stop ? 0 : -1;
      row.toggleAttribute(STOP, row === stop);
      for (const action of actionsOf(row)) action.tabIndex = -1;
    }
  }
}

export function rememberStop(target: EventTarget | null): void {
  if (!isButton(target)) return;
  const section = target.closest("section");
  if (section === null || !rowsOf(section).includes(target)) return;
  for (const row of rowsOf(section)) {
    row.tabIndex = row === target ? 0 : -1;
    row.toggleAttribute(STOP, row === target);
  }
}

/** The row whose action this is: the first button of the list item (a direct child of the section) that holds it. */
function ownRow(target: HTMLButtonElement): HTMLButtonElement | undefined {
  const holder = target.closest("section > div");
  const row = holder === null ? undefined : rowOf(holder);
  return row !== undefined && row !== target && actionsOf(row).includes(target) ? row : undefined;
}

/**
 * An action the arrow keys can land on: enabled, and laid out. A touch screen draws an agent row's More alone (#950),
 * so its Pin is display:none there and focusing it would do nothing.
 */
const reachable = (action: HTMLButtonElement): boolean => !action.disabled && action.checkVisibility();

/** The element an unmodified arrow, Home or End key moves focus to, or undefined when the key is not ours. */
export function rovingTarget(root: Element, target: EventTarget | null, key: string): HTMLButtonElement | undefined {
  if (!isButton(target)) return undefined;
  const section = target.closest("section");
  if (section === null || !root.contains(section)) return undefined;
  const owner = ownRow(target);
  if (owner !== undefined) {
    if (key === "ArrowLeft") return owner;
    if (key !== "ArrowRight") return undefined;
    const actions = actionsOf(owner).filter(reachable);
    return actions[actions.indexOf(target) + 1];
  }
  const rows = rowsOf(section);
  const index = rows.indexOf(target);
  if (index === -1) return undefined;
  switch (key) {
    case "ArrowDown":
      return rows[index + 1];
    case "ArrowUp":
      return rows[index - 1];
    case "Home":
      return rows[0];
    case "End":
      return rows.at(-1);
    case "ArrowRight":
      return actionsOf(target).find(reachable);
    default:
      return undefined;
  }
}
