import { Button, Dialog, Field, Input } from "@doriface/ui";
import { useId, useState } from "react";
import { NotNowLine } from "./not-now-line.tsx";

export interface RenameDialogProps {
  readonly title: string;
  /** The name the field starts with, when that is not `title` (a tab shown by its program's title has no name). */
  readonly value?: string;
  readonly busy: boolean;
  readonly error: string | null;
  /** Why the name cannot be written now (its layout takes no edits), or null: Rename waits, disabled, and says why. */
  readonly refused?: string | null;
  readonly description?: string;
  readonly onRename: (name: string) => void;
  readonly onCancel: () => void;
}

export function RenameDialog({
  title,
  value = title,
  busy,
  error,
  refused = null,
  description = "Every device shows the new name. Leave it empty to show the program's own title again.",
  onRename,
  onCancel,
}: RenameDialogProps) {
  const id = useId();
  const [name, setName] = useState(value);
  // Why Rename waits now; null while it is free or writing.
  const waiting = busy ? null : refused;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A rename that is writing cannot be taken back: its question stays until the write settles (#1498).
        if (!open && !busy) onCancel();
      }}
      title={`Rename ${title}`}
      description={description}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || waiting !== null) return;
          onRename(name);
        }}
        className="flex flex-col gap-5"
      >
        <Field label="Name" htmlFor={id} {...(error === null ? {} : { error })}>
          <Input id={id} value={name} maxLength={80} autoFocus onValueChange={(next: string) => setName(next)} />
        </Field>
        {waiting === null ? null : <NotNowLine action="Rename" why={waiting} />}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} disabled={waiting !== null}>
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
