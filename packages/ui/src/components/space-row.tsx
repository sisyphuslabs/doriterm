import { ChevronRight, Folder } from "lucide-react";
import { useRef } from "react";
import { cn } from "../lib/cn.ts";
import { useRowFloors } from "./row-floors.ts";
import { SpaceAvatar, type AvatarColor } from "./space-avatar.tsx";
import { StatusIndicator, type AgentStatus } from "./status.tsx";

/** A space's git state, given only when it is unusual (another branch, detached, ahead or behind, uncommitted). */
export interface SpaceGit {
  /** Absent when HEAD is detached. */
  readonly branch?: string;
  readonly detached: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly dirty: boolean;
}

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

/** The branch, or "detached": the part that shrinks to an ellipsis. */
function gitHead(git: SpaceGit): string {
  return git.detached || git.branch === undefined ? "detached" : git.branch;
}

/** The star for uncommitted changes, then ahead and behind: these always show whole. */
function gitCounts(git: SpaceGit): string {
  return `${git.dirty ? "*" : ""}${git.ahead > 0 ? ` \u2191${git.ahead}` : ""}${git.behind > 0 ? ` \u2193${git.behind}` : ""}`;
}

/** `feat/x* \u21912 \u21931`: the branch (or "detached"), a star for uncommitted changes, then ahead and behind. */
export function gitText(git: SpaceGit): string {
  return gitHead(git) + gitCounts(git);
}

/** The same in words, for the tooltip and the accessible name. */
export function gitWords(git: SpaceGit): string {
  return [
    git.detached || git.branch === undefined ? "Detached HEAD" : `On ${git.branch}`,
    git.ahead > 0 ? `${plural(git.ahead, "commit")} ahead` : undefined,
    git.behind > 0 ? `${plural(git.behind, "commit")} behind` : undefined,
    git.dirty ? "uncommitted changes" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

export interface Space {
  readonly id: string;
  readonly name: string;
  readonly machine?: string;
  /** Number of tabs. */
  readonly tabs: number;
  /** The most urgent agent status inside, if any. */
  readonly attention?: AgentStatus;
  /** Its avatar colour; a folder stands in until one is assigned. */
  readonly color?: AvatarColor;
  readonly git?: SpaceGit;
}

export interface SpaceRowProps {
  readonly space: Space;
  readonly selected?: boolean;
  readonly onSelect?: (id: string) => void;
  /** The sidebar is an icon rail: the avatar alone, the name as its label and tooltip. */
  readonly rail?: boolean;
  /** Under a machine's header the machine is already said, so the row leaves it out. */
  readonly hideMachine?: boolean;
  /** The row opens a screen of its own (the phone): a trailing chevron says so. */
  readonly chevron?: boolean;
  readonly className?: string;
}

/**
 * A workspace (herdr space) in the sidebar: avatar, name, machine, its most urgent agent, tab count. When the row is
 * short the machine gives way first; the name keeps five characters and an ellipsis (see useRowFloors).
 */
export function SpaceRow({
  space,
  selected = false,
  onSelect,
  rail = false,
  hideMachine = false,
  chevron = false,
  className,
}: SpaceRowProps) {
  const row = useRef<HTMLButtonElement | null>(null);
  const machine = hideMachine ? undefined : space.machine;
  const git = space.git === undefined ? undefined : gitText(space.git);
  useRowFloors(row, `${space.name}\u0000${machine ?? ""}\u0000${git ?? ""}`);
  const mark =
    space.color === undefined ? (
      <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    ) : (
      // The avatar is 2 px wider than the size-4 glyph every sidebar row leads with; taking those 2 px out of the gap
      // keeps the name on the label column the section titles start on (#1612).
      <SpaceAvatar name={space.name} color={space.color} {...(rail ? {} : { className: "-mr-0.5" })} />
    );
  return (
    <button
      ref={row}
      type="button"
      aria-current={selected ? "true" : undefined}
      {...(rail ? { "aria-label": space.name, title: space.name } : {})}
      onClick={() => onSelect?.(space.id)}
      className={cn(
        "flex h-(--row) w-full min-w-0 items-center gap-2.5 rounded-md text-left text-sm text-foreground outline-none",
        "hover:bg-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring",
        rail ? "justify-center px-0" : "px-2",
        selected && "bg-selected",
        className,
      )}
    >
      {mark}
      {rail ? null : (
        <>
          <span title={space.name} data-floor="name" className="min-w-0 flex-1 truncate">
            {space.name}
          </span>
          {git === undefined || space.git === undefined ? null : (
            <span
              data-git
              data-floor="detail"
              title={gitWords(space.git)}
              aria-label={gitWords(space.git)}
              className="flex min-w-0 max-w-[40%] text-2xs whitespace-pre text-muted-foreground"
            >
              <span className="min-w-0 truncate">{gitHead(space.git)}</span>
              <span className="shrink-0">{gitCounts(space.git)}</span>
            </span>
          )}
          {machine === undefined ? null : (
            <span
              title={machine}
              data-floor="machine"
              className="min-w-0 max-w-[35%] truncate text-2xs text-muted-foreground"
            >
              {machine}
            </span>
          )}
          <span data-row-meta className="flex shrink-0 items-center gap-2.5">
            {space.attention === undefined ? null : <StatusIndicator status={space.attention} className="size-3" />}
            <span
              data-numeric
              aria-label={`${space.tabs} tabs`}
              className="min-w-4 text-right text-xs whitespace-nowrap text-muted-foreground"
            >
              {space.tabs}
            </span>
            {chevron ? <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}
          </span>
        </>
      )}
    </button>
  );
}
