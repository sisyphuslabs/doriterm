import type { MachineView } from "@doriface/protocol";
import { Button, type ButtonProps, Dialog, Notice } from "@doriface/ui";
import { useState } from "react";
import { meshLineHostId } from "../mesh/groups.ts";

/**
 * Whether the app offers Remove for this machine (#2456): one added by hand. A mesh member's line is the reconciler's
 * to keep, and removing a member is a revoke, so its copy-the-revoke-command stays its only way out.
 */
export const removable = (view: MachineView | undefined): view is MachineView =>
  view !== undefined && meshLineHostId(view) === undefined;

export const removeLabel = (name: string): string => `Remove ${name}\u2026`;

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export interface RemoveMachineDialogProps {
  /** The machine asked about, or null while no question is open. */
  readonly name: string | null;
  readonly onClose: () => void;
  readonly onRemove: (machine: string) => Promise<void>;
}

/** The one confirmation: what leaves and what keeps running. A refusal stays in the question, with hc's reason. */
export function RemoveMachineDialog({ name, onClose, onRemove }: RemoveMachineDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<string | null>(name);
  if (asked !== name) {
    setAsked(name);
    setBusy(false);
    setError(null);
  }
  if (name === null) return null;
  const submit = (): void => {
    setBusy(true);
    setError(null);
    onRemove(name).then(onClose, (cause: unknown) => {
      setBusy(false);
      setError(messageOf(cause));
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // A remove on its way cannot be taken back: the question stays until hc answers.
        if (!open && !busy) onClose();
      }}
      title={`Remove ${name}?`}
      description="Its spaces leave this list; anything running there keeps running."
      actions={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" loading={busy} onClick={submit}>
            Remove
          </Button>
        </>
      }
    >
      {error === null ? undefined : (
        <Notice tone="error" title={`${name} was not removed`}>
          {error}
        </Notice>
      )}
    </Dialog>
  );
}

export interface RemoveMachineButtonProps extends Pick<ButtonProps, "size" | "className"> {
  readonly name: string;
  readonly onRemove: (machine: string) => Promise<void>;
}

/**
 * Remove <machine>… beside a machine's Try again, with its own confirmation. It sits under the machine's name, so it reads
 * Remove… and keeps the name in its accessible name: a long name would push it past a phone's width (#2456).
 */
export function RemoveMachineButton({ name, onRemove, size, className }: RemoveMachineButtonProps) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        aria-label={removeLabel(name)}
        onClick={() => setAsking(true)}
        {...(size === undefined ? {} : { size })}
        {...(className === undefined ? {} : { className })}
      >
        Remove…
      </Button>
      <RemoveMachineDialog name={asking ? name : null} onClose={() => setAsking(false)} onRemove={onRemove} />
    </>
  );
}
