import { Button, EmptyState } from "@doriface/ui";
import { SquareTerminal } from "lucide-react";
import { notNowText } from "./not-now-line.tsx";

export interface PhoneEmptyProps {
  readonly host: string;
  readonly onNew: () => void;
  /** Offered disabled with New tab (#2455, #2574 review). */
  readonly newDisabled?: boolean;
  /** Why it is disabled, said in the description (visual QA: a disabled control says why). */
  readonly newWhy?: string | null;
  readonly onAddMachine: () => void;
}

/** The phone's list with no terminal: what is missing and the two ways forward. */
export function PhoneEmpty({ host, onNew, newDisabled = false, newWhy = null, onAddMachine }: PhoneEmptyProps) {
  return (
    <EmptyState
      icon={<SquareTerminal aria-hidden />}
      title="No terminals yet"
      description={
        newDisabled && newWhy !== null
          ? notNowText(newWhy, "New terminal comes back by itself once the machine can take it.")
          : `Start a shell on ${host}, or add a machine to reach its terminals here.`
      }
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
