import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { KeyboardEvent, Ref } from "react";
import { cn } from "../lib/cn.ts";
import { IconButton } from "./icon-button.tsx";

export interface FindBarProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** The current match (0-based) and how many there are; null while the query is empty. */
  readonly result: { readonly current: number | null; readonly total: number } | null;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  /** Escape in the field, or the close button. */
  readonly onClose: () => void;
  readonly inputRef?: Ref<HTMLInputElement>;
  readonly className?: string;
}

/** How a match is drawn over terminal cells, the current one stronger; shared by the live terminal and mockups. */
export const FIND_MATCH_CLASS = "rounded-[2px] bg-status-working/30";
export const FIND_CURRENT_CLASS = "rounded-[2px] bg-status-working/65 outline outline-1 outline-status-working";

const resultText = (result: FindBarProps["result"]): string => {
  if (result === null) return "";
  if (result.total === 0) return "No matches";
  return `${(result.current ?? 0) + 1} of ${result.total}`;
};

/**
 * A find bar floated over a terminal (herdr-app's terminal.search): Enter and Shift+Enter step through the matches,
 * Escape closes it. The count is a polite live region, so a screen reader hears "3 of 12" or "No matches".
 */
export function FindBar({
  query,
  onQueryChange,
  result,
  onNext,
  onPrevious,
  onClose,
  inputRef,
  className,
}: FindBarProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };
  const stepping = result !== null && result.total > 0;
  return (
    <div
      role="search"
      data-slot="find-bar"
      className={cn(
        "flex items-center gap-1 rounded-md border border-border bg-popover py-1 pr-1 pl-2 text-popover-foreground shadow-overlay",
        className,
      )}
    >
      <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="search"
        aria-label="Find in terminal"
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        value={query}
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={onKeyDown}
        className="h-(--control-sm) w-40 min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground coarse:text-base [&::-webkit-search-cancel-button]:hidden"
      />
      <span
        role="status"
        aria-live="polite"
        data-find-result
        className={cn(
          "shrink-0 px-1 text-xs whitespace-nowrap tabular-nums",
          result?.total === 0 ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {resultText(result)}
      </span>
      <IconButton
        label="Previous match"
        keys={["⇧", "⏎"]}
        icon={<ChevronUp aria-hidden />}
        disabled={!stepping}
        onClick={onPrevious}
      />
      <IconButton
        label="Next match"
        keys={["⏎"]}
        icon={<ChevronDown aria-hidden />}
        disabled={!stepping}
        onClick={onNext}
      />
      <IconButton label="Close find" keys={["Esc"]} icon={<X aria-hidden />} onClick={onClose} />
    </div>
  );
}
