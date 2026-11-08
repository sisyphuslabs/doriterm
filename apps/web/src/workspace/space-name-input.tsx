import { Input, type Space } from "@doriface/ui";
import { useId, useState } from "react";
import { useSpaceRenaming } from "./space-rename-context.ts";

export interface SpaceNameInputProps {
  readonly space: Space;
  /** Ends the edit: after the name is written, or on Esc, or when focus leaves without a commit. */
  readonly onClose: () => void;
}

/**
 * A space's name edited in place of its row: Enter writes it for every device, Esc (or leaving the field) puts the
 * name back unwritten. A name that cannot be used, or a write that fails, says why under the field and keeps it open.
 */
export function SpaceNameInput({ space, onClose }: SpaceNameInputProps) {
  const renaming = useSpaceRenaming();
  const [name, setName] = useState(space.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const inputId = useId();
  const commit = (): void => {
    if (busy) return;
    if (name.trim() === space.name) return onClose();
    const problem = renaming.problem(space.id, name);
    if (problem !== null) return setError(problem);
    setBusy(true);
    renaming.rename(space.id, name).then(onClose, (cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  return (
    // A terminal its first click opened must not take the keyboard from the field as it starts (mayTakeFocus).
    <div data-holds-keyboard className="flex flex-col gap-1">
      <label id={`${inputId}-label`} htmlFor={inputId} className="sr-only">
        Rename space {space.name}
      </label>
      <Input
        id={inputId}
        autoFocus
        aria-labelledby={`${inputId}-label`}
        {...(error === null ? {} : { "aria-describedby": errorId })}
        invalid={error !== null}
        value={name}
        maxLength={80}
        readOnly={busy}
        className="h-(--row) px-2 text-sm"
        onFocus={(event) => event.currentTarget.select()}
        onValueChange={(next: string) => {
          setName(next);
          setError(null);
        }}
        onBlur={() => {
          if (!busy) onClose();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Enter") commit();
          else onClose();
        }}
      />
      {error === null ? null : (
        <p id={errorId} role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
