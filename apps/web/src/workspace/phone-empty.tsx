import { Button, EmptyState } from "@doriface/ui";
import { SquareTerminal } from "lucide-react";

export interface PhoneEmptyProps {
  readonly host: string;
  readonly onNew: () => void;
  /** Offered disabled with New tab (#2455, #2519 review). */
  readonly newDisabled?: boolean;
  readonly onAddMachine: () => void;
}

/** The phone's list with no terminal: what is missing and the two ways forward. */
export function PhoneEmpty({ host, onNew, newDisabled = false, onAddMachine }: PhoneEmptyProps) {
  return (
    <EmptyState
      icon={<SquareTerminal aria-hidden />}
      title="No terminals yet"
      description={`Start a shell on ${host}, or add a machine to reach its terminals here.`}
      actions={
        <>
          <Button variant="primary" disabled={newDisabled} onClick={onNew}>
            New terminal
          </Button>
          <Button onClick={onAddMachine}>Add a machine</Button>
        </>
      }
    />
  );
}
