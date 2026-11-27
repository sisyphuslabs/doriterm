import { cn, SpaceAvatar, StatusIndicator, type Space } from "@doriface/ui";
import { Folder } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useSpaceRenaming } from "./space-rename-context.ts";

export interface SpaceNameInputProps {
  readonly space: Space;
  /** Ends the edit: after the name is written, or on Esc, or when focus leaves. */
  readonly onClose: () => void;
}

/**
 * In-place space name editor keeping the exact SpaceRow layout (avatar, tab count, attention mark)
 * so double-clicking or choosing Rename edits only the name text with zero vertical row jump.
 */
export function SpaceNameInput({ space, onClose }: SpaceNameInputProps) {
  const renaming = useSpaceRenaming();
  const [name, setName] = useState(space.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const inputId = useId();

  const cancel = (): void => {
    cancelled.current = true;
    onClose();
  };

  const commit = (fromBlur = false): void => {
    if (busy || cancelled.current) return;
    const trimmed = name.trim();
    if (trimmed === space.name || (fromBlur && trimmed === "")) {
      onClose();
      return;
    }
    const problem = renaming.problem(space.id, name);
    if (problem !== null) {
      if (fromBlur) onClose();
      else setError(problem);
      return;
    }
    setBusy(true);
    renaming.rename(space.id, name).then(onClose, (cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  const commitLatest = useRef(commit);
  commitLatest.current = commit;

  // Clicking the terminal canvas or non-focusable chrome may not fire blur while data-holds-keyboard is active.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (inputRef.current !== null && event.target instanceof Node && !inputRef.current.contains(event.target)) {
        commitLatest.current(true);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const mark =
    space.color === undefined ? (
      <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    ) : (
      <SpaceAvatar name={space.name} color={space.color} className="-mr-0.5" />
    );

  return (
    // A terminal its first click opened must not take the keyboard from the field as it starts (mayTakeFocus).
    <div data-holds-keyboard className="flex flex-col">
      <div className="flex h-(--row) w-full min-w-0 items-center gap-2.5 rounded-md bg-selected px-2 text-left text-sm text-foreground">
        {mark}
        <label id={`${inputId}-label`} htmlFor={inputId} className="sr-only">
          Rename space {space.name}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          autoFocus
          aria-labelledby={`${inputId}-label`}
          aria-invalid={error !== null || undefined}
          {...(error === null ? {} : { "aria-describedby": errorId })}
          value={name}
          maxLength={80}
          readOnly={busy}
          className={cn(
            "h-6 min-w-0 flex-1 rounded-xs bg-surface/80 px-1.5 text-sm text-foreground ring-1 outline-none",
            error !== null ? "ring-destructive" : "ring-ring/70",
          )}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setName(event.currentTarget.value);
            setError(null);
          }}
          onBlur={() => commit(true)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Enter") commit(false);
            else cancel();
          }}
        />
        <span data-row-meta className="flex shrink-0 items-center gap-2.5">
          {space.attention === undefined ? null : <StatusIndicator status={space.attention} className="size-3" />}
          <span
            data-numeric
            aria-label={`${space.tabs} tabs`}
            className="min-w-4 text-right text-xs whitespace-nowrap text-muted-foreground"
          >
            {space.tabs}
          </span>
        </span>
      </div>
      {error === null ? null : (
        <p id={errorId} role="alert" className="px-2 pt-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
