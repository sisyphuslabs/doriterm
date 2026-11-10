import type { HcConnection } from "@doriface/client";
import { Button, Dialog } from "@doriface/ui";
import { useEffect, useState } from "react";

/** How much of a named file the card shows: enough to see what an edit or a plan touches, not a whole log. */
const SHOWN_LINES = 400;

/** A path the card can open: absolute, or relative to the agent's directory. `~` is the agent's shell's, not hc's. */
export const canOpenFile = (path: string): boolean => path !== "" && !path.startsWith("~");

/** The machine a terminal address lives on (`box/t3` is on `box`), for a file read there. */
const machineOf = (address: string): string | undefined => {
  const slash = address.indexOf("/");
  return slash === -1 ? undefined : address.slice(0, slash);
};

type Read =
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly text: string; readonly more: boolean }
  | { readonly kind: "failed"; readonly reason: string };

/** A file the prompt names, read over hc (`file.read`) on the terminal's own machine, from the agent's directory. */
export function FileView({
  connection,
  terminal,
  cwd,
  path,
  onClose,
}: {
  readonly connection: HcConnection;
  readonly terminal: string;
  readonly cwd: string;
  readonly path: string;
  readonly onClose: () => void;
}) {
  const [read, setRead] = useState<Read>({ kind: "reading" });
  useEffect(() => {
    let live = true;
    const on = machineOf(terminal);
    connection
      .call("file.read", { path, cwd, limit: SHOWN_LINES, ...(on === undefined ? {} : { on }) })
      .then((result) => live && setRead({ kind: "read", text: result.text, more: result.lines > result.last }))
      .catch(
        (error: unknown) =>
          live && setRead({ kind: "failed", reason: error instanceof Error ? error.message : String(error) }),
      );
    return () => {
      live = false;
    };
  }, [connection, terminal, cwd, path]);
  return (
    <Dialog
      open
      onOpenChange={(open) => open || onClose()}
      title={path}
      className="w-[min(48rem,calc(100%-2rem))]"
      actions={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {read.kind === "reading" ? (
        <p className="text-prose text-muted-foreground">Reading…</p>
      ) : read.kind === "failed" ? (
        <p className="text-prose text-muted-foreground">Could not read it: {read.reason}</p>
      ) : (
        <>
          <pre className="m-0 max-h-[60dvh] overflow-auto rounded-md bg-raised p-2.5 font-mono text-xs whitespace-pre text-foreground">
            {read.text}
          </pre>
          {read.more ? (
            <p className="mt-2 text-xs text-muted-foreground">
              The first {SHOWN_LINES} lines; the rest is in the file.
            </p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
