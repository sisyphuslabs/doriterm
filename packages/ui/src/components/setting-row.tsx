import { Ban } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";

/** Spread onto a disabled row's control so assistive tech reads the reason with it. */
export interface SettingReason {
  readonly "aria-describedby": string;
}

interface SettingRowBase {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** The config file key this row writes, e.g. a Ghostty key; shown as a monospace label. */
  readonly configKey?: string;
  /** Keep the control trailing on narrow screens instead of stacking it full width. */
  readonly inline?: boolean;
  readonly id?: string;
  readonly className?: string;
}

interface EnabledSettingRow extends SettingRowBase {
  readonly control: ReactNode;
  readonly disabledReason?: undefined;
}

interface DisabledSettingRow extends SettingRowBase {
  /** Builds the disabled control; spread the reason onto it so the reason is read with it. */
  readonly control: (reason: SettingReason) => ReactNode;
  /** Why this setting cannot apply here, in words. The row stays visible; pass `disabled` to the control as well. */
  readonly disabledReason: string;
}

export type SettingRowProps = EnabledSettingRow | DisabledSettingRow;

/** A settings line: what it is on the left, the control on the right; stacks under 480 px unless inline. */
export function SettingRow(props: SettingRowProps) {
  const { title, description, configKey, disabledReason, inline = false, id, className } = props;
  const disabled = disabledReason !== undefined;
  const reasonId = useId();
  const control =
    props.disabledReason === undefined ? props.control : props.control({ "aria-describedby": reasonId });
  return (
    <div
      data-setting-row=""
      className={cn(
        "flex items-center gap-x-6 gap-y-2 border-b border-border py-3.5 last:border-b-0",
        "data-setting-landed:rounded-md data-setting-landed:bg-selected",
        inline ? "flex-nowrap" : "flex-wrap",
        className,
      )}
    >
      <div className={cn("min-w-0 flex-1", !inline && "min-w-[min(16rem,100%)]")}>
        <p id={id} className={cn("text-base", disabled ? "text-muted-foreground" : "text-foreground")}>
          {title}
        </p>
        {configKey === undefined ? null : <p className="mt-0.5 font-mono text-xs text-muted-foreground">{configKey}</p>}
        {description === undefined ? null : (
          <p className="mt-0.5 text-prose text-pretty text-muted-foreground">{description}</p>
        )}
        {disabled ? (
          <p id={reasonId} className="mt-1 flex items-start gap-1.5 text-prose text-muted-foreground">
            <Ban aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="text-pretty">{disabledReason}</span>
          </p>
        ) : null}
      </div>
      {/* A row with nothing to do has no control slot: an empty one would still take its own line under 480 px. */}
      {control === null || control === undefined ? null : (
        <div
          className={cn(
            "flex max-w-full shrink-0 items-center gap-2",
            !inline && "max-sm:w-full max-sm:[&>*]:flex-1 sm:[&>*]:flex-none",
          )}
        >
          {control}
        </div>
      )}
    </div>
  );
}
