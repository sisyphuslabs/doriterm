import type { WorkspaceTab } from "@doriface/ui";
import { type ReactNode, useState } from "react";
import { RenameDialog } from "./rename-dialog.tsx";
import type { Layout } from "./use-layout.ts";

/** The tab whose Rename question is open, and how its write went. */
interface Renaming {
  readonly key: string;
  readonly busy: boolean;
  readonly error: string | null;
}

/**
 * A tab's Rename question: `open` asks for tab `key`'s name, and `dialog` is the question while one is open. A tab whose
 * layout takes no edits is asked with Rename disabled and why, and Rename comes back by itself (#2455): never offered,
 * then refused after the press.
 */
export function useTabRename(
  layout: Pick<Layout, "tabs" | "renameTab">,
  tabs: readonly WorkspaceTab[],
): { readonly open: (key: string) => void; readonly dialog: ReactNode } {
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const { renameTab } = layout;
  const submit = (key: string, name: string): void => {
    setRenaming({ key, busy: true, error: null });
    renameTab(key, name.trim()).then(
      () => setRenaming(null),
      (cause: unknown) =>
        setRenaming({ key, busy: false, error: cause instanceof Error ? cause.message : String(cause) }),
    );
  };
  const open = (key: string): void => setRenaming({ key, busy: false, error: null });
  const renamed = renaming === null ? undefined : layout.tabs.find((tab) => tab.key === renaming.key);
  if (renaming === null || renamed === undefined) return { open, dialog: null };
  const shownTitle = tabs.find((tab) => tab.id === renamed.key)?.title ?? "";
  // A number alone names nothing, so it reads "tab 2"; an agent's title (#1541) or a name reads as itself.
  const title = renamed.name !== "" ? renamed.name : /^\d*$/.test(shownTitle) ? `tab ${shownTitle}`.trim() : shownTitle;
  // A tab not in any document yet is no machine's to wait for: its press still says why it was not saved.
  const refused =
    renamed.transient || renamed.readOnly === null ? null : `The layout cannot take changes now: ${renamed.readOnly}`;
  return {
    open,
    dialog: (
      <RenameDialog
        key={renaming.key}
        title={title}
        value={renamed.name}
        busy={renaming.busy}
        error={renaming.error}
        refused={refused}
        description="Every device shows the new name. Leave it empty to call the tab by its agent, or by its number, again."
        onRename={(name) => submit(renaming.key, name)}
        onCancel={() => setRenaming(null)}
      />
    ),
  };
}
