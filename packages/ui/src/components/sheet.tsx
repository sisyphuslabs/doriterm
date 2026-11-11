import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { backdropClass, modalLayer, wrapAnywhere } from "./overlay.ts";

const SIDE = {
  right:
    "inset-y-0 right-0 w-[min(24rem,100%)] border-l pt-(--safe-top) pr-(--safe-right) pb-(--safe-bottom) data-starting-style:translate-x-full data-ending-style:translate-x-full",
  bottom:
    "inset-x-0 bottom-0 max-h-[85dvh] rounded-t-xl border-t pr-(--safe-right) pb-(--safe-bottom) pl-(--safe-left) data-starting-style:translate-y-full data-ending-style:translate-y-full",
} as const;

/** The title and a visible Done that closes the sheet; it is not dragged, so it draws no grabber. */
const TITLE_ROW = "flex items-center gap-2 pt-2 pr-2 pb-1 pl-4";
const DONE = "font-semibold text-foreground";

export interface SheetProps {
  readonly title: ReactNode;
  readonly side?: keyof typeof SIDE;
  readonly children: ReactNode;
  readonly trigger?: ReactElement;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}

/** A panel that slides in from an edge; on phones the bottom sheet replaces popovers. */
/** The sheet's panel drawn in place, for static compositions. */
export function SheetPanel({ title, side = "bottom", children }: Pick<SheetProps, "title" | "side" | "children">) {
  return (
    <div
      role="dialog"
      aria-label={typeof title === "string" ? title : undefined}
      className={cn(
        "flex flex-col border-border bg-popover text-popover-foreground shadow-overlay",
        wrapAnywhere,
        side === "bottom" ? "rounded-t-xl border-t" : "border-l",
      )}
    >
      <div className={TITLE_ROW}>
        <p className="min-w-0 flex-1 text-base font-semibold">{title}</p>
        <Button variant="ghost" size="sm" className={DONE}>
          Done
        </Button>
      </div>
      <div className="px-4 pb-4">{children}</div>
    </div>
  );
}

export function Sheet({ title, side = "right", children, trigger, open, onOpenChange }: SheetProps) {
  return (
    <BaseDialog.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      {trigger === undefined ? null : <BaseDialog.Trigger render={trigger} />}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className={backdropClass} />
        <BaseDialog.Popup
          className={cn(
            modalLayer,
            "fixed flex flex-col border-border bg-popover text-popover-foreground shadow-overlay outline-none",
            wrapAnywhere,
            "transition-transform duration-(--duration-standard) ease-out motion-reduce:transition-opacity",
            SIDE[side],
          )}
        >
          <div className={TITLE_ROW}>
            <BaseDialog.Title className="min-w-0 flex-1 text-xl font-semibold">{title}</BaseDialog.Title>
            <BaseDialog.Close render={<Button variant="ghost" size="sm" className={DONE} />}>Done</BaseDialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
