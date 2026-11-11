import type { ReactElement, ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { Tooltip } from "./tooltip.tsx";

export interface SidebarFooterItemProps {
  readonly icon: ReactNode;
  readonly label: string;
  /** A small dot after the label (on the rail, on the icon) that says something waits there, e.g. an update. */
  readonly dot?: string;
  readonly rail?: boolean;
  readonly onClick?: () => void;
  /** Renders as another element, e.g. a router link. */
  readonly render?: ReactElement;
}

/** One entry in the sidebar's footer: icon and label, the icon alone with a tooltip on the rail. */
export function SidebarFooterItem({ icon, label, dot, rail = false, onClick, render }: SidebarFooterItemProps) {
  const name = dot === undefined ? label : `${label}, ${dot}`;
  const mark =
    dot === undefined ? null : (
      <span
        aria-hidden
        data-slot="footer-dot"
        className={cn("size-1.5 shrink-0 rounded-full bg-brand", rail && "absolute top-1 right-1")}
      />
    );
  const button = (
    <Button
      variant="ghost"
      aria-label={name}
      {...(onClick === undefined ? {} : { onClick })}
      {...(render === undefined ? {} : { render })}
      className={cn(
        "text-sm [&_svg:not([data-slot=spinner])]:size-3.5",
        rail ? "relative size-(--control) px-0" : "justify-start gap-2.5 px-2",
      )}
    >
      {icon}
      {rail ? null : <span className="flex-1 text-left">{label}</span>}
      {mark}
    </Button>
  );
  return rail ? (
    <Tooltip label={name} side="right">
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/** The sidebar's footer: hairline above, its items stacked (on the rail, centred). */
export function SidebarFooter({ rail = false, children }: { readonly rail?: boolean; readonly children: ReactNode }) {
  return (
    <div
      data-slot="sidebar-footer"
      className={cn("flex shrink-0 flex-col gap-px border-t border-sidebar-border p-2", rail && "items-center px-0")}
    >
      {children}
    </div>
  );
}
