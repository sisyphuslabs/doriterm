import type { HcConnection } from "@doriface/client";
import { Button } from "@doriface/ui";
import { useState } from "react";
import { WAITING_KEYS } from "./waiting-keys.ts";

/**
 * The answer strip over a terminal whose agent waits on a person with no card (#1527): each tap presses exactly that key
 * in the terminal and nothing else; the strip goes once the agent stops waiting. A press that fails says so and can be
 * tapped again.
 */
export function WaitingKeysStrip({ connection, address }: { connection: HcConnection; address: string }) {
  const [failed, setFailed] = useState(false);
  const press = (key: string) => {
    setFailed(false);
    connection.call("terminal.keys", { terminal: address, keys: [key] }).catch(() => setFailed(true));
  };
  return (
    <div
      role="group"
      aria-label="Answer the waiting agent"
      data-waiting-keys={address}
      className="pointer-events-auto flex w-full max-w-2xl flex-wrap items-center gap-2 rounded-xl border border-border bg-chrome/95 p-2 shadow-lg backdrop-blur-md"
    >
      <p className="mr-auto px-1 text-prose font-medium text-status-blocked-text">
        {failed ? "That key did not reach the terminal" : "Waiting for input"}
      </p>
      {WAITING_KEYS.map((each) => (
        <Button
          key={each.key}
          variant="secondary"
          aria-label={each.name}
          // The terminal keeps its focus: on a phone a focused button would drop the keyboard, or raise none.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => press(each.key)}
          className="h-11 min-w-11 px-3 font-mono"
        >
          {each.label}
        </Button>
      ))}
    </div>
  );
}
