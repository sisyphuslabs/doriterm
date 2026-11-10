import { RotateCcw, TriangleAlert } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { Kbd } from "./kbd.tsx";

export type ShortcutState = "idle" | "recording" | "conflict";

export interface ShortcutFieldProps {
  /** Action name, used in accessible labels. */
  readonly action: string;
  /** The bound keys, one entry per key, e.g. ["⌘", "⇧", "P"]. */
  readonly keys: readonly string[];
  readonly state?: ShortcutState;
  /** Keys pressed while recording, shown as they arrive. */
  readonly pending?: readonly string[];
  /** In the conflict state: the action that already owns the pressed keys. */
  readonly conflictWith?: string;
  /** Differs from the default binding: shows a reset control. */
  readonly modified?: boolean;
  readonly onRecord?: () => void;
  readonly onCancel?: () => void;
  readonly onReplace?: () => void;
  readonly onReset?: () => void;
  readonly className?: string;
}

/**
 * A key binding you can re-record. Idle shows the chips as a button that starts recording;
 * recording says so in words; a conflict names the other action and asks before taking its keys.
 */
export function ShortcutField({
  action,
  keys,
  state = "idle",
  pending = [],
  conflictWith,
  modified = false,
  onRecord,
  onCancel,
  onReplace,
  onReset,
  className,
}: ShortcutFieldProps) {
  return (
    <div className={cn("flex flex-col items-end gap-2", className)}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={
            {
              idle: `${action}: ${keys.join(" ")}. Record a new shortcut`,
              recording: `${action}: recording, press the new keys`,
              conflict: `${action}: ${pending.join(" ")} is already used by ${conflictWith ?? "another action"}`,
            }[state]
          }
          aria-disabled={state === "idle" ? undefined : true}
          onClick={state === "idle" ? onRecord : undefined}
          className={cn(
            "flex h-(--control-sm) min-w-32 items-center justify-center gap-1.5 rounded-md border px-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring",
            state === "idle" ? "border-input hover:bg-hover" : "border-ring bg-surface text-foreground",
          )}
        >
          {state === "idle" ? <Kbd keys={keys} persistent /> : null}
          {state !== "idle" && pending.length === 0 ? <span className="text-muted-foreground">Press keys…</span> : null}
          {state !== "idle" && pending.length > 0 ? <Kbd keys={pending} persistent /> : null}
        </button>
        <span role="status" className="sr-only">
          {state === "recording" ? "Press keys…" : ""}
        </span>
        {state === "idle" && modified ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Reset ${action} to default`}
            onClick={onReset}
            className="px-1.5"
          >
            <RotateCcw />
          </Button>
        ) : null}
        {state === "recording" ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      {state === "conflict" ? (
        <div role="alert" className="flex flex-col items-end gap-2 text-right sm:max-w-80">
          <p className="flex items-start gap-1.5 text-prose text-foreground">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span className="text-pretty">Already used by {conflictWith ?? "another action"}. Move it here?</span>
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button size="sm" onClick={onReplace}>
              Move to {action}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
