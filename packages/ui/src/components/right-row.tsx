import type { ReactNode } from "react";
import { SegmentedControl } from "./segmented-control.tsx";
import { Switch } from "./switch.tsx";

export interface RightRowProps {
  readonly title: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly onEnabledChange?: (enabled: boolean) => void;
  readonly mode?: "ask" | "allow";
  readonly onModeChange?: (mode: "ask" | "allow") => void;
  readonly allowLabel?: string;
  readonly children?: ReactNode;
}

/** One right in the attach form: title and optional description on the left, mode and switch (or Always on) on the right. */
export function RightRow({
  title,
  description,
  enabled,
  onEnabledChange,
  mode,
  onModeChange,
  allowLabel,
  children,
}: RightRowProps) {
  const alwaysOn = onEnabledChange === undefined;
  const active = alwaysOn ? true : enabled;
  return (
    <div className="flex flex-col gap-2.5 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-[min(10rem,100%)] flex-1">
          <p className="text-base text-foreground">{title}</p>
          {description === undefined ? null : (
            <p className="mt-0.5 text-prose text-pretty text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2.5">
          {active && mode !== undefined ? (
            <SegmentedControl
              compact
              label={`${title} mode`}
              value={mode}
              {...(onModeChange === undefined ? {} : { onValueChange: onModeChange })}
              options={[
                { value: "ask", label: "Ask me" },
                { value: "allow", label: allowLabel ?? "Allow" },
              ]}
            />
          ) : null}
          {alwaysOn ? (
            <span className="text-xs font-medium text-muted-foreground">Always on</span>
          ) : (
            <Switch aria-label={title} checked={active} onCheckedChange={onEnabledChange} />
          )}
        </div>
      </div>
      {active && children !== undefined ? <div>{children}</div> : null}
    </div>
  );
}
