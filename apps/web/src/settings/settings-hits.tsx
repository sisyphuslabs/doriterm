import { Button, cn } from "@doriface/ui";
import { type KeyboardEvent, useEffect } from "react";
import type { SettingHit } from "./setting-rows.ts";
import { SectionHeader, SettingsCard, rowDetailClass, rowValueClass } from "./settings-layout.tsx";
import { SECTIONS } from "./settings-sections.tsx";

const sectionLabel = (hit: SettingHit): string => SECTIONS.find((each) => each.id === hit.section)?.label ?? "";

const FOCUSABLE = 'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])';

/** Moves focus between the hits with the arrow keys; Up from the first goes back to the search field. */
function stepHits(event: KeyboardEvent<HTMLElement>, onLeave: () => void): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const buttons = [...(event.currentTarget.closest("[data-setting-hits]")?.querySelectorAll("button") ?? [])];
  const at = buttons.indexOf(event.currentTarget as HTMLButtonElement);
  event.preventDefault();
  const next = buttons[at + (event.key === "ArrowDown" ? 1 : -1)];
  if (next === undefined && event.key === "ArrowUp") onLeave();
  else next?.focus();
}

/** The settings a search found (#1528), each a row naming its section; picking one opens that section on that row. */
export function SettingHits(props: {
  readonly hits: readonly SettingHit[];
  readonly onOpen: (hit: SettingHit) => void;
  readonly onLeave: () => void;
}) {
  return (
    <section aria-label="Matching settings" data-setting-hits className="flex flex-col">
      <SectionHeader title="Matching settings" />
      <SettingsCard>
        <ul className="flex flex-col">
          {props.hits.map((hit) => (
            <li key={`${hit.section}:${hit.title}`} className="border-b border-border last:border-b-0">
              <Button
                variant="ghost"
                onClick={() => props.onOpen(hit)}
                onKeyDown={(event) => stepHits(event, props.onLeave)}
                data-list-row
                className="h-auto min-h-(--settings-row-min) w-full flex-col items-start justify-center gap-0.5 rounded-none py-(--settings-row-y) pr-[var(--settings-row-reach,0px)] pl-0 text-left"
              >
                <span className="flex w-full items-baseline justify-between gap-3">
                  <span className="text-(length:--settings-row-title) leading-[1.375rem] text-foreground">
                    {hit.title}
                  </span>
                  <span data-row-value className={cn("shrink-0", rowValueClass)}>
                    {sectionLabel(hit)}
                  </span>
                </span>
                <span data-row-detail className={cn("line-clamp-1 font-normal", rowDetailClass)}>
                  {hit.detail}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      </SettingsCard>
    </section>
  );
}

/** Outside the list of matches, whose own buttons read the same titles. */
const drawn = (element: Element): boolean => element.closest("[data-setting-hits]") === null;

/** The drawn row a hit names: by its title's id, else the setting row (or the one control) whose title reads it. */
function findRow(body: Element, hit: SettingHit): HTMLElement | undefined {
  if (hit.anchor !== undefined) {
    const title = body.querySelector(`[id="${CSS.escape(hit.anchor)}"]`);
    if (title instanceof HTMLElement) return title.closest<HTMLElement>("[data-setting-row]") ?? title;
  }
  const rows = [...body.querySelectorAll<HTMLElement>("[data-setting-row]")].filter(drawn);
  const row = rows.find((each) => each.querySelector("p")?.textContent?.trim() === hit.title);
  if (row !== undefined) return row;
  const controls = [...body.querySelectorAll<HTMLElement>("button, a")].filter(drawn);
  return controls.find((each) => each.textContent?.trim().startsWith(hit.title));
}

function land(row: HTMLElement): void {
  row.scrollIntoView({ block: "center" });
  row.setAttribute("data-setting-landed", "");
  // The row's own control (SettingRow's control slot): its pressed or checked choice when it has one, else its first
  // usable control. A row with a slot never lands anywhere else: when nothing in it can be used (a key this build does not
  // apply), the row itself takes the focus, so a key's Reset on the title line, whose next Space would undo the value, is
  // never chosen. Only a row with no slot lands on its first usable control. Anything hidden or disabled is passed over.
  const usable = (scope: Element): HTMLElement[] =>
    [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (candidate) => getComputedStyle(candidate).visibility !== "hidden" && !candidate.matches(":disabled"),
    );
  const slot = row.querySelector("[data-setting-control]");
  const own = slot === null ? [] : usable(slot);
  const chosen = own.find((candidate) => candidate.matches('[aria-pressed="true"], [aria-checked="true"]')) ?? own[0];
  const control = row.matches(FOCUSABLE) ? row : slot === null ? usable(row)[0] : chosen;
  if (control !== undefined) {
    control.focus({ preventScroll: true });
    return;
  }
  if (!row.hasAttribute("tabindex")) row.setAttribute("tabindex", "-1");
  row.focus({ preventScroll: true });
}

/**
 * Lands on `hit`'s row once its section has drawn it: at once if it is there, else on the first change to the body
 * that brings it (a section can draw its rows after it mounts). Stops when the hit changes, a new search starts (null)
 * or Settings closes; a row this device does not draw is never found, and the next search ends the wait.
 */
export function useLandOn(hit: SettingHit | null, body: () => Element | null): void {
  useEffect(() => {
    const root = body();
    if (root === null) return undefined;
    for (const old of root.querySelectorAll("[data-setting-landed]")) old.removeAttribute("data-setting-landed");
    if (hit === null) return undefined;
    const now = findRow(root, hit);
    if (now !== undefined) {
      land(now);
      return undefined;
    }
    const watch = new MutationObserver(() => {
      const found = findRow(root, hit);
      if (found === undefined) return;
      watch.disconnect();
      land(found);
    });
    watch.observe(root, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [hit, body]);
}
