import { Button } from "@doriface/ui";
import { Monitor, Plus, Server } from "lucide-react";
import type { Computer } from "./computers.ts";

/**
 * Every computer this phone can use, in one list, whatever brought it here (#1296).
 *
 * The person should not have to know whether a computer arrived through the mesh or through its own pairing: it is a
 * computer they can use, and the row says whether it is reachable. The list is shown even with a single computer, because
 * a list you can only see once you already have two is how someone never learns the second one is possible.
 */
export function ComputersList({
  machines,
  onAdd,
  onPick,
}: {
  readonly machines: readonly Computer[];
  readonly onAdd: () => void;
  readonly onPick?: (machine: Computer) => void;
}) {
  return (
    <section aria-label="Computers" className="flex flex-col gap-1 px-3 py-2">
      <h2 className="px-1 pb-1 text-xs font-medium text-muted-foreground">Computers</h2>
      <ul className="flex flex-col">
        {machines.map((machine) => (
          <li key={machine.id}>
            <button
              type="button"
              onClick={() => onPick?.(machine)}
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-2 text-left text-sm hover:bg-accent"
            >
              {machine.state === "this" ? <Monitor aria-hidden className="size-4" /> : <Server aria-hidden className="size-4" />}
              <span className="min-w-0 flex-1 truncate">{machine.name}</span>
              <span className="text-xs text-muted-foreground">
                {machine.state === "this" ? "this computer" : machine.state === "offline" ? (machine.reason ?? "offline") : "connected"}
              </span>
            </button>
          </li>
        ))}
        <li>
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2" onClick={onAdd}>
            <Plus aria-hidden className="size-4" />
            Add a computer
          </Button>
          <p className="px-1 pb-2 text-xs text-pretty text-muted-foreground">
            Run <code>doriface-host mesh join</code> on the other computer to put it in your mesh (recommended), or scan
            its QR code to pair just this phone.
          </p>
        </li>
      </ul>
    </section>
  );
}
