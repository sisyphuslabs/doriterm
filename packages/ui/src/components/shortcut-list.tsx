import { useId } from "react";
import { cn } from "../lib/cn.ts";
import { groupHeadingClass } from "./input.tsx";
import { Kbd } from "./kbd.tsx";

export interface ShortcutRow {
  readonly id: string;
  readonly label: string;
  /** Every chord bound to the action, each as its key chips. */
  readonly chords: readonly (readonly string[])[];
}

export interface ShortcutGroup {
  readonly title: string;
  readonly rows: readonly ShortcutRow[];
}

export interface ShortcutListProps {
  readonly groups: readonly ShortcutGroup[];
  readonly className?: string;
}

/**
 * Bound keys, grouped under a heading per group: label on the left, every chord on the right. The chords are the
 * content here, not a hint, so they stay drawn on touch layouts (`Kbd persistent`).
 */
export function ShortcutList({ groups, className }: ShortcutListProps) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {groups.map((group, index) => (
        <section key={group.title} aria-labelledby={`${id}-${index}`} className="flex flex-col">
          <h3 id={`${id}-${index}`} className={cn("pb-1", groupHeadingClass)}>
            {group.title}
          </h3>
          <ul className="flex flex-col">
            {group.rows.map((row) => (
              <li
                key={row.id}
                className="flex min-h-(--row) items-center justify-between gap-3 border-b border-border py-1 last:border-b-0"
              >
                <span className="min-w-0 truncate text-base text-foreground">{row.label}</span>
                <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  {row.chords.map((keys) => (
                    <Kbd key={keys.join("+")} keys={keys} persistent />
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
