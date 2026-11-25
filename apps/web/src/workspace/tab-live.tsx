import { AgentMark } from "@doriface/ui";
import type { ReactElement, ReactNode } from "react";
import { markKind, type Session, terminalTitle } from "./model.ts";
import { useShown } from "./use-shown.ts";

/**
 * The mark of what runs in front of a pane's shell now, as herdr-app's tab strip draws its program icons: the agent's
 * own where it has one, else an agent's, a shell's or another program's. It alone draws again as a program starts or
 * ends (#2607). The tab's title names it, so the mark is for the eye only.
 */
function FrontIcon({ terminal }: { readonly terminal: Session }) {
  const [now = terminal] = useShown([terminal], markKind);
  return <AgentMark kind={markKind(now)} size={14} className="text-muted-foreground" decorative />;
}

const fronts = new WeakMap<Session, ReactElement>();

/** One icon element per terminal entry, so a tab whose terminals kept their shape is drawn by its strip as it was. */
export function frontIcon(terminal: Session): ReactElement {
  const known = fronts.get(terminal);
  if (known !== undefined) return known;
  const icon = <FrontIcon terminal={terminal} />;
  fronts.set(terminal, icon);
  return icon;
}

/** Hands a terminal's title as it stands to `children`; a title change draws this part alone (#2607). */
export function Titled({
  terminal,
  children,
}: {
  readonly terminal: Session;
  readonly children: (title: string) => ReactNode;
}) {
  const [now = terminal] = useShown([terminal]);
  return children(terminalTitle(now));
}
