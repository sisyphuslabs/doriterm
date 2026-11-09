import type { HcConnection } from "@doriface/client";
import { ApprovalBanner, approvalAnnouncement } from "@doriface/ui";
import { useEffect, useState } from "react";
import type { Session } from "../workspace/model.ts";
import { canOpenFile, FileView } from "./file-view.tsx";
import { useApproval } from "./use-approval.ts";
import { waitsOnKeys } from "./waiting-keys.ts";
import { WaitingKeysStrip } from "./waiting-keys-strip.tsx";

/**
 * The card pinned over a terminal while its agent waits on a person; the terminal below stays usable. Its polite live
 * region is mounted, empty, for as long as the terminal is shown, and the text is written into it after each change,
 * so screen readers announce the prompt appearing and every state after it.
 */
export function ApprovalOverlay({ connection, terminal }: { connection: HcConnection; terminal: Session }) {
  const approval = useApproval(connection, terminal);
  const said = approval === undefined ? "" : approvalAnnouncement(approval.mark.prompt, approval.state);
  const [announced, setAnnounced] = useState("");
  const [file, setFile] = useState<string | undefined>(undefined);
  useEffect(() => setAnnounced(said), [said]);
  return (
    <>
      <p data-approval-live={terminal.address} aria-live="polite" aria-atomic="true" className="sr-only">
        {announced}
      </p>
      {approval === undefined && waitsOnKeys(terminal) ? (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-10 flex flex-col items-center">
          <WaitingKeysStrip connection={connection} address={terminal.address} />
        </div>
      ) : null}
      {approval === undefined ? null : (
        <div
          data-approval={terminal.address}
          className="pointer-events-none absolute inset-x-2 top-2 z-10 flex max-h-[calc(100%-1rem)] flex-col items-center"
        >
          <ApprovalBanner
            prompt={approval.mark.prompt}
            state={approval.state}
            cwd={approval.mark.cwd}
            onAnswer={approval.answer}
            onDismiss={approval.dismiss}
            onOpenFile={setFile}
            canOpenFile={canOpenFile}
            className="pointer-events-auto min-h-0 w-full max-w-2xl"
          />
        </div>
      )}
      {approval === undefined || file === undefined ? null : (
        <FileView
          connection={connection}
          terminal={terminal.address}
          cwd={approval.mark.cwd}
          path={file}
          onClose={() => setFile(undefined)}
        />
      )}
    </>
  );
}
