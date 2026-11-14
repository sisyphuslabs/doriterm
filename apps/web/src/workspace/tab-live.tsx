import { Bot, SquareTerminal, Terminal } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { programKind, type Session, terminalTitle } from "./model.ts";
import { useShown } from "./use-shown.ts";

/** herdr-app's program icons for what a tab runs: an agent, a shell, or another program (its `defaults/icons`). */
export const PROGRAM_ICON = {
  agent: <Bot aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
  shell: <Terminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
  program: <SquareTerminal aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />,
};

/** The icon of what runs in front of a pane's shell now: it alone draws again as a program starts or ends (#2607). */
function FrontIcon({ terminal }: { readonly terminal: Session }) {
  const [now = terminal] = useShown([terminal], programKind);
  return PROGRAM_ICON[programKind(now)];
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
