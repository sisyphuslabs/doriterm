import { Check, CircleSlash } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { Kbd } from "./kbd.tsx";
import { StatusIndicator } from "./status.tsx";

export type ApprovalAnswer = "allow" | "deny";

/** A permission prompt as the host read it off the agent's screen. */
export interface ApprovalPrompt {
  readonly agent: string;
  /** The agent's own verb phrase: "wants to run", "wants to edit". */
  readonly asks: string;
  /** The exact command or tool call, shown whole: never truncated, since it is what gets allowed. */
  readonly command: string;
  /** The agent's own keys for each answer, pressed as if typed. */
  readonly keys: Readonly<Record<ApprovalAnswer, string>>;
}

/**
 * waiting: answerable. sending: the host is checking the prompt is still on the live screen, then pressing the key.
 * stale: the prompt went away before the key was pressed, so nothing was sent. answered: resolved here or elsewhere.
 */
export type ApprovalBannerState =
  | { readonly kind: "waiting" }
  | { readonly kind: "sending"; readonly answer: ApprovalAnswer }
  | { readonly kind: "stale" }
  | { readonly kind: "answered"; readonly answer: ApprovalAnswer; readonly where: string };

export interface ApprovalBannerProps {
  readonly prompt: ApprovalPrompt;
  readonly state: ApprovalBannerState;
  readonly onAnswer?: (answer: ApprovalAnswer) => void;
  readonly onDismiss?: () => void;
  readonly className?: string;
}

const ANSWER_LABEL = { allow: "Allow", deny: "Deny" } as const;
const ANSWERED_LABEL = { allow: "Allowed", deny: "Denied" } as const;

const frame =
  "flex flex-col gap-2 rounded-lg border border-border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-overlay coarse:gap-3 coarse:p-3";

/** Pinned over a terminal while its agent waits on a permission prompt; the terminal below stays the source of truth. */
export function ApprovalBanner({ prompt, state, onAnswer, onDismiss, className }: ApprovalBannerProps) {
  if (state.kind === "answered") {
    return (
      <section
        role="status"
        aria-label={`${prompt.agent} prompt`}
        className={cn(frame, "flex-row items-center gap-2.5", className)}
      >
        <Check aria-hidden className="size-4 shrink-0 text-foreground" />
        <p className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-foreground">{ANSWERED_LABEL[state.answer]}</span>
          <span className="ml-2 font-mono text-xs text-muted-foreground">{prompt.command}</span>
        </p>
        <span className="shrink-0 text-xs text-muted-foreground">{state.where}</span>
      </section>
    );
  }

  if (state.kind === "stale") {
    return (
      <section role="status" aria-label={`${prompt.agent} prompt`} className={cn(frame, className)}>
        <div className="flex items-start gap-2.5">
          <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-muted-foreground">
            <span className="font-semibold text-foreground">The prompt went away.</span> Nothing was sent; the terminal
            shows what {prompt.agent} is doing now.
          </p>
          <Button variant="ghost" size="sm" onClick={onDismiss} className="-my-1 shrink-0">
            Dismiss
          </Button>
        </div>
      </section>
    );
  }

  const sending = state.kind === "sending" ? state.answer : undefined;
  const answerButton = (answer: ApprovalAnswer) => (
    <Button
      variant={answer === "allow" ? "primary" : "secondary"}
      size="sm"
      loading={sending === answer}
      disabled={sending !== undefined && sending !== answer}
      onClick={() => onAnswer?.(answer)}
      className="coarse:w-full"
    >
      {ANSWER_LABEL[answer]}
      <Kbd
        keys={[prompt.keys[answer]]}
        className="[&>span]:border-current/30 [&>span]:bg-transparent [&>span]:text-current"
      />
    </Button>
  );
  return (
    <section aria-label={`${prompt.agent} ${prompt.asks}`} className={cn(frame, className)}>
      <div className="flex items-center gap-2.5">
        <StatusIndicator status="blocked" />
        <p className="min-w-0 flex-1 truncate text-muted-foreground">
          <span className="font-semibold text-foreground">{prompt.agent}</span> {prompt.asks}
        </p>
        <div className="flex shrink-0 gap-2 coarse:hidden">
          {answerButton("deny")}
          {answerButton("allow")}
        </div>
      </div>
      <pre className="m-0 rounded-md bg-raised px-2.5 py-1.5 font-mono text-[0.8125rem] leading-[1.45] break-all whitespace-pre-wrap text-foreground">
        {prompt.command}
      </pre>
      <div className="hidden grid-cols-2 gap-2 coarse:grid">
        {answerButton("deny")}
        {answerButton("allow")}
      </div>
      {sending === undefined ? null : (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          Checking the prompt is still on screen, then pressing {prompt.keys[sending]}…
        </p>
      )}
    </section>
  );
}
