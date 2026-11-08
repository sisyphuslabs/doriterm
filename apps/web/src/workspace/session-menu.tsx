import { IconButton, Menu, MenuItem } from "@doriface/ui";
import { Ellipsis, Pencil, Power } from "lucide-react";
import { useAskSession } from "./session-context.ts";

export interface SessionMenuProps {
  readonly address: string;
  readonly title: string;
}

/** What can be done with a terminal's session: its "..." menu and a split pane header's right-click hold the same items. */
export function SessionMenuItems({ address }: { readonly address: string }) {
  const ask = useAskSession();
  return (
    <>
      <MenuItem icon={<Pencil />} onClick={() => ask({ kind: "rename", address })}>
        Rename…
      </MenuItem>
      <MenuItem icon={<Power />} destructive onClick={() => ask({ kind: "end", address })}>
        End session…
      </MenuItem>
    </>
  );
}

/** The actions on a terminal's session: rename it, or end its program. */
export function SessionMenu({ address, title }: SessionMenuProps) {
  const label = `Session actions for ${title}`;
  return (
    <Menu align="end" trigger={<IconButton label={label} icon={<Ellipsis />} className="size-6" />}>
      <SessionMenuItems address={address} />
    </Menu>
  );
}
