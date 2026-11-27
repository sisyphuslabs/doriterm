import { useRef } from "react";
import { currentWidthTier } from "../layout/width-tier.ts";
import { SHEET_OUT, useLeaveMotion } from "./leave-motion.ts";
import { Sidebar, type SidebarProps } from "./sidebar.tsx";

type DrawerProps = Omit<SidebarProps, "rail" | "onExpand" | "drawer"> & { readonly onClose: () => void };

const ARRIVES = "motion-arrive [--arrive-duration:var(--duration-sheet-in)] [--arrive-ease:var(--ease-standard)]";

/** A drawer dropped because the window left the medium tier plays nothing: only one the person closed slides out. */
const closedInPlace = (): boolean => currentWidthTier() === "medium";

/**
 * The medium tier's sidebar over the rail (DESIGN.md 6, Drawer): it slides in from the leading edge as its scrim fades
 * in, and leaves the same way back on the exit curve.
 */
export function SidebarDrawer({ onClose, ...sidebar }: DrawerProps) {
  const scrim = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // The scrim's picture first, so the panel's paints over it.
  useLeaveMotion(scrim, { keyframes: [{ opacity: 1 }, { opacity: 0 }], timing: SHEET_OUT }, closedInPlace);
  useLeaveMotion(
    panel,
    { keyframes: [{ transform: "none" }, { transform: "translateX(-100%)" }], timing: SHEET_OUT },
    closedInPlace,
  );
  return (
    <>
      <button
        ref={scrim}
        type="button"
        aria-label="Close sidebar"
        className={`${ARRIVES} absolute inset-0 z-30 bg-black/30 [--arrive-from:none]`}
        onClick={onClose}
      />
      <div
        ref={panel}
        data-sidebar-drawer
        className={`${ARRIVES} absolute top-(--safe-top) bottom-(--safe-bottom) left-(--safe-left) z-40 flex [--arrive-from:translateX(-100%)]`}
      >
        <Sidebar drawer {...sidebar} />
      </div>
    </>
  );
}
