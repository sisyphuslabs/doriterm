import { Button, EmptyState } from "@doriface/ui";
import { SquareTerminal } from "lucide-react";

export interface PhoneEmptyProps {
  readonly host: string;
  readonly onNew: () => void;
  readonly onConnect: () => void;
}

/** The phone's list with no terminal: what is missing and the two ways forward. */
export function PhoneEmpty({ host, onNew, onConnect }: PhoneEmptyProps) {
  return (
    <EmptyState
      icon={<SquareTerminal aria-hidden />}
      title="No terminals yet"
      description={`Start a shell on ${host}, or connect a device to reach its terminals here.`}
      actions={
        <>
          <Button variant="primary" onClick={onNew}>
            New terminal
          </Button>
          <Button onClick={onConnect}>Connect a device</Button>
        </>
      }
    />
  );
}
