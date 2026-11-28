import { IconButton, Input } from "@doriface/ui";
import { ListFilter, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";
import { useActionKeys } from "../keys/use-action-keys.ts";
import { terminalInput } from "./focus-targets.ts";

export interface SidebarFilterState {
  /** The field is out: it was asked for, or it still holds a query. */
  readonly open: boolean;
  readonly query: string;
  /** Counts the asks for the field, so each one puts focus in it even when it is already out. */
  readonly asks: number;
}

/** The sidebar's filter for this window only: a reload starts with the lists whole. */
class SidebarFilterStore {
  #value: SidebarFilterState = { open: false, query: "", asks: 0 };
  #listeners = new Set<() => void>();
  get value(): SidebarFilterState {
    return this.#value;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #set(patch: Partial<SidebarFilterState>): void {
    this.#value = { ...this.#value, ...patch };
    for (const listener of this.#listeners) listener();
  }
  ask(): void {
    this.#set({ open: true, asks: this.#value.asks + 1 });
  }
  type(query: string): void {
    this.#set({ query });
  }
  close(): void {
    this.#set({ open: false, query: "" });
  }
}

export const sidebarFilter = new SidebarFilterStore();

export function useSidebarFilter(): SidebarFilterState {
  return useSyncExternalStore(sidebarFilter.subscribe, () => sidebarFilter.value);
}

/**
 * The filter field under the sidebar's title: what is typed narrows the lists below to the rows whose labels match.
 * Escape clears a query, and on an empty field closes it and gives focus back to the terminal.
 */
export function SidebarFilterField() {
  const { open, query, asks } = useSidebarFilter();
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open, asks]);
  if (!open) return null;
  return (
    <div className="mx-2 mb-2 flex shrink-0 flex-col">
      <label htmlFor={id} className="sr-only">
        Filter sidebar
      </label>
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={field}
          id={id}
          type="search"
          placeholder="Filter spaces & agents…"
          value={query}
          onChange={(event) => sidebarFilter.type(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (query !== "") {
              sidebarFilter.type("");
              return;
            }
            sidebarFilter.close();
            terminalInput()?.focus();
          }}
          className={
            query !== ""
              ? "h-8 border-border bg-raised/50 pr-7 pl-8 text-sm focus-visible:bg-surface"
              : "h-8 border-border bg-raised/50 pl-8 text-sm focus-visible:bg-surface"
          }
        />
        {query === "" ? null : (
          <IconButton
            label="Clear filter"
            icon={<X />}
            onClick={() => {
              sidebarFilter.type("");
              field.current?.focus();
            }}
            className="absolute top-1/2 right-1 size-6 -translate-y-1/2 [&_svg:not([data-slot=spinner])]:size-3"
          />
        )}
      </div>
    </div>
  );
}

/**
 * Opens and closes the filter field, in the Spaces header beside New space: the title row stays as it is, and the app's
 * name there ellipsizes only when the row is narrower than it.
 */
export function FilterButton() {
  const { open } = useSidebarFilter();
  const keys = useActionKeys("layout.filter:sidebar");
  return (
    <IconButton
      label="Filter sidebar"
      pressed={open}
      {...(keys === undefined ? {} : { keys })}
      icon={<ListFilter />}
      onClick={() => (open ? sidebarFilter.close() : sidebarFilter.ask())}
    />
  );
}
