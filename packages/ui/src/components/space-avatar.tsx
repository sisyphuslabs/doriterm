import { cn } from "../lib/cn.ts";

/** The avatar hues, in the order a new space takes the least used one. */
export const AVATAR_COLORS = ["teal", "orange", "blue", "violet", "green", "pink"] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

const TONE: Readonly<Record<AvatarColor, string>> = {
  teal: "bg-avatar-teal/15 text-avatar-teal ring-avatar-teal/30",
  orange: "bg-avatar-orange/15 text-avatar-orange ring-avatar-orange/30",
  blue: "bg-avatar-blue/15 text-avatar-blue ring-avatar-blue/30",
  violet: "bg-avatar-violet/15 text-avatar-violet ring-avatar-violet/30",
  green: "bg-avatar-green/15 text-avatar-green ring-avatar-green/30",
  pink: "bg-avatar-pink/15 text-avatar-pink ring-avatar-pink/30",
};

export interface SpaceAvatarProps {
  readonly name: string;
  readonly color: AvatarColor;
  readonly className?: string;
}

/** A space's stable mark: its initial in a soft tonal badge. Decorative: the space's name is always beside it. */
export function SpaceAvatar({ name, color, className }: SpaceAvatarProps) {
  const initial = [...name.replace(/^[^\p{L}\p{N}]+/u, "")][0]?.toUpperCase() ?? "~";
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4.5 shrink-0 items-center justify-center rounded-[5px] text-2xs leading-none font-semibold ring-1 ring-inset",
        TONE[color],
        className,
      )}
    >
      {initial}
    </span>
  );
}
