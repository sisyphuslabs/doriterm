import { Button, Notice } from "@doriface/ui";
import { useState } from "react";
import { browserPasskey } from "./passkey.ts";
import { type PreparedRestore, prepareRestore } from "./restore.ts";

export function RestoreEntry() {
  const [attempt, setAttempt] = useState<PreparedRestore>();
  const [state, setState] = useState<"idle" | "busy" | "waiting" | "off">("idle");
  const [message, setMessage] = useState<string>();
  if (browserPasskey() === undefined) return null;

  const run = async () => {
    const passkey = browserPasskey();
    if (passkey === undefined) return;
    setMessage(undefined);
    setState("busy");
    let prepared = attempt;
    try {
      prepared ??= await prepareRestore(passkey, "restored-phone");
      setAttempt(prepared);
      const result = await prepared.attempt();
      if (result === "waiting") setState("waiting");
      else {
        setAttempt(undefined);
        if (result === "restored") location.assign("/");
        else setState("off");
      }
    } catch (error) {
      setState(prepared === undefined ? "idle" : "waiting");
      setMessage(error instanceof Error ? error.message : "Ask a member for an invite.");
    }
  };

  if (state === "off")
    return (
      <Notice title="Device restored. Passkey restore is off.">
        You can set it up again in Settings. <Button render={<a href="/" />}>Open Doriterm</Button>
      </Notice>
    );

  return (
    <section className="flex flex-col gap-2" aria-label="Passkey restore">
      {state === "waiting" && attempt !== undefined ? (
        <Notice title="Waiting for a mesh member">
          Compare this code with the member approving the restore: <strong>{attempt.code}</strong>.
        </Notice>
      ) : null}
      {message === undefined ? null : <p role="status">{message}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="lg" variant="secondary" disabled={state === "busy"} onClick={() => void run()}>
          {attempt === undefined ? "Restore with a passkey" : "Check for approval"}
        </Button>
        {attempt === undefined || state === "busy" ? null : (
          <Button
            variant="ghost"
            onClick={() => {
              attempt.discard();
              setAttempt(undefined);
              setState("idle");
              setMessage(undefined);
            }}
          >
            Cancel restore
          </Button>
        )}
      </div>
    </section>
  );
}
