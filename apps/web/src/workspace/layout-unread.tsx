import { EmptyState } from "@doriface/ui";
import { TriangleAlert } from "lucide-react";

/** The saved tabs could not be read: the read's own reason, never an empty workspace that reads as "no tabs" (#2443). */
export function LayoutUnread({ reason }: { readonly reason: string }) {
  return (
    <EmptyState
      className="flex-1"
      icon={<TriangleAlert aria-hidden />}
      title="Your tabs could not be read"
      description={`${reason.replace(/\.$/, "")}. Trying again; they come back as soon as the layout can be read.`}
    />
  );
}
