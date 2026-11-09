import { Button } from "@doriface/ui";
import { type KeyboardEvent, useEffect } from "react";
import type { SettingHit } from "./setting-rows.ts";
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
      <h2 className="pb-1 text-lg font-semibold text-foreground md:text-xl">Matching settings</h2>
      <ul className="flex flex-col">
        {props.hits.map((hit) => (
          <li key={`${hit.section}:${hit.title}`} className="border-b border-border last:border-b-0">
            <Button
              variant="ghost"
              onClick={() => props.onOpen(hit)}
              onKeyDown={(event) => stepHits(event, props.onLeave)}
              className="h-auto w-full flex-col items-start gap-0.5 px-2 py-2.5 text-left"
            >
              <span className="flex w-full items-baseline justify-between gap-3">
                <span className="text-base text-foreground">{hit.title}</span>
                <span className="shrink-0 text-sm text-muted-foreground">{sectionLabel(hit)}</span>
              </span>
              <span className="line-clamp-1 text-sm font-normal text-muted-foreground">{hit.detail}</span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The drawn row a hit names: by its title's id, else the setting row (or the one control) whose title reads it. */
function findRow(body: Element, hit: SettingHit): HTMLElement | undefined {
  if (hit.anchor !== undefined) {
    const title = body.querySelector(`[id="${CSS.escape(hit.anchor)}"]`);
    if (title instanceof HTMLElement) return title.closest<HTMLElement>("[data-setting-row]") ?? title;
  }
  const rows = [...body.querySelectorAll<HTMLElement>("[data-setting-row]")];
  const row = rows.find((each) => each.querySelector("p")?.textContent?.trim() === hit.title);
  if (row !== undefined) return row;
  const controls = [...body.querySelectorAll<HTMLElement>("button, a")];
  return controls.find((each) => each.textContent?.trim().startsWith(hit.title));
}

function land(row: HTMLElement): void {
  row.scrollIntoView({ block: "center" });
  row.setAttribute("data-setting-landed", "");
  const control = row.matches(FOCUSABLE) ? row : row.querySelector<HTMLElement>(FOCUSABLE);
  (control ?? row).focus({ preventScroll: true });
}

/**
 * Lands on `hit`'s row once its section has drawn it: at once if it is there, else on the first change to the body
 * that brings it (a section can draw its rows after it mounts). Stops when the hit changes or Settings closes.
 */
export function useLandOn(hit: SettingHit | null, body: () => Element | null): void {
  useEffect(() => {
    const root = body();
    if (hit === null || root === null) return undefined;
    for (const old of root.querySelectorAll("[data-setting-landed]")) old.removeAttribute("data-setting-landed");
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
