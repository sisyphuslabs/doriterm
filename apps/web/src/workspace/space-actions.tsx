import { IconButton, Menu, MenuItem, type Space } from "@doriface/ui";
import { ArrowDown, ArrowUp, Ellipsis, Pencil, X } from "lucide-react";
import { useSpaceClosing } from "./space-close-context.ts";
import { useSpaceRenaming } from "./space-rename-context.ts";
import type { SpaceReorder } from "./space-list.tsx";

/**
 * A space row's "..." menu: Rename space asks for the new name; Close space asks before it ends the space's tabs. Move
 * up and Move down are the list's single-pointer path (WCAG 2.5.7), with the move keys the rows themselves take.
 */
export function SpaceActions({
  space,
  reorder,
  onRename,
}: {
  readonly space: Space;
  readonly reorder: SpaceReorder | undefined;
  readonly onRename?: () => void;
}) {
  return (
    <Menu align="end" trigger={<IconButton label={`More for ${space.name}`} icon={<Ellipsis />} className="size-6" />}>
      <SpaceMenuItems space={space} reorder={reorder} {...(onRename === undefined ? {} : { onRename })} />
    </Menu>
  );
}

/**
 * What can be done with a space: its "..." menu and its right-click menu hold the same items, on a phone its list row's
 * "..." and the space screen's own "..." too.
 */
export function SpaceMenuItems({
  space,
  reorder,
  onRename,
}: {
  readonly space: Pick<Space, "id">;
  readonly reorder: SpaceReorder | undefined;
  /** When given (full desktop sidebar), renames the space inline right on the row instead of opening a modal dialog. */
  readonly onRename?: () => void;
}) {
  const renaming = useSpaceRenaming();
  const closing = useSpaceClosing();
  return (
    <>
      <MenuItem
        icon={<Pencil />}
        disabled={renaming.refusal(space.id) !== null}
        onClick={() => (onRename === undefined ? renaming.ask(space.id) : queueMicrotask(onRename))}
      >
        Rename space…
      </MenuItem>
      {reorder === undefined ? null : (
        <>
          <MenuItem
            icon={<ArrowUp />}
            disabled={reorder.index === 0}
            {...(reorder.keys.up === undefined ? {} : { keys: reorder.keys.up })}
            onClick={() => reorder.move(reorder.index - 1)}
          >
            Move up
          </MenuItem>
          <MenuItem
            icon={<ArrowDown />}
            disabled={reorder.index === reorder.count - 1}
            {...(reorder.keys.down === undefined ? {} : { keys: reorder.keys.down })}
            onClick={() => reorder.move(reorder.index + 1)}
          >
            Move down
          </MenuItem>
        </>
      )}
      <MenuItem
        icon={<X />}
        destructive
        disabled={closing.refusal(space.id) !== null}
        onClick={() => closing.ask(space.id)}
      >
        Close space…
      </MenuItem>
    </>
  );
}
