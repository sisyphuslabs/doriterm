import type { HcConnection } from "@doriface/client";
import type { Terminal } from "@doriface/protocol";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { ListedSpace } from "./model.ts";
import { RenameDialog } from "./rename-dialog.tsx";
import { sessionCalls } from "./session-actions.ts";
import { SpaceRenameContext, type SpaceRenaming } from "./space-rename-context.ts";
import { renameRefusal, renameSpace, spaceNameProblem } from "./space-rename.ts";
import type { MachineLayout } from "./use-layout-docs.ts";

export interface SpaceRenameProps {
  readonly connection: HcConnection;
  readonly terminals: readonly Terminal[];
  /** The machines' layouts, which a rename is written to. */
  readonly layouts: readonly MachineLayout[];
  /** The spaces as the sidebar lists them (layoutSpaces). */
  readonly spaces: readonly ListedSpace[];
  /** The space whose Rename question is open (the sidebar's menu, or the palette for the session in view), or null. */
  readonly ask: string | null;
  readonly onAsk: (id: string | null) => void;
  readonly children: ReactNode;
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Renaming spaces for everything inside it (SpaceRenameContext), and the Rename question for the space asked about. */
export function SpaceRename({ connection, terminals, layouts, spaces, ask, onAsk, children }: SpaceRenameProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The name the question asks with, read as it opens: it stays while the rename it starts reaches the list.
  const [asked, setAsked] = useState<{ readonly id: string | null; readonly name: string }>({ id: null, name: "" });
  if (asked.id !== ask) {
    setAsked({ id: ask, name: spaces.find((space) => space.id === ask)?.name ?? "" });
    setBusy(false);
    setError(null);
  }
  // Read when a rename is checked and written, so a context value made before the latest lists never acts on older ones.
  const latest = useRef({ terminals, layouts, spaces });
  latest.current = { terminals, layouts, spaces };
  const renaming = useMemo<SpaceRenaming>(() => {
    const problem = (id: string, name: string): string | null =>
      spaceNameProblem(latest.current.spaces, id, name) ?? renameRefusal(latest.current.layouts, id);
    return {
      ask: onAsk,
      // From this render's layouts, so the menu's Rename follows the machine going and coming back.
      refusal: (id) => renameRefusal(layouts, id),
      problem,
      rename: async (id, name) => {
        const refused = problem(id, name);
        if (refused !== null) throw new Error(refused);
        const now = latest.current;
        await renameSpace(sessionCalls(connection), now.layouts, now.spaces, now.terminals, id, name);
      },
    };
  }, [connection, onAsk, layouts]);
  const submit = (id: string, name: string): void => {
    const problem = renaming.problem(id, name);
    if (problem !== null) return setError(problem);
    setBusy(true);
    setError(null);
    renaming.rename(id, name).then(
      () => onAsk(null),
      (cause: unknown) => {
        setBusy(false);
        setError(messageOf(cause));
      },
    );
  };
  return (
    <SpaceRenameContext value={renaming}>
      {children}
      {ask === null ? null : (
        <RenameDialog
          title={asked.name}
          busy={busy}
          error={error}
          refused={renaming.refusal(ask)}
          description="Every device of this machine shows the new name."
          onRename={(name) => submit(ask, name)}
          onCancel={() => onAsk(null)}
        />
      )}
    </SpaceRenameContext>
  );
}
