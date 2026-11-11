import { Check, CircleSlash, FileText, Send } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { cn } from "../lib/cn.ts";
import { Button } from "./button.tsx";
import { fieldLabelClass, Input } from "./input.tsx";
import { Kbd } from "./kbd.tsx";
import { StatusIndicator } from "./status.tsx";

/** One row of the agent's own option list, in its own words. */
export interface ApprovalOption {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  /** The agent's own keys for the row; empty for a row only the cursor reaches. */
  readonly keys: readonly string[];
  /** The agent's No row. */
  readonly declines: boolean;
  /** The row takes typed text. */
  readonly typed: boolean;
  /** A multi-select row's box, as checked on screen. */
  readonly checked?: boolean;
}

/** An interactive prompt as the agent drew it on its live screen: a permission, a question, or a plan to approve. */
export interface ApprovalPrompt {
  readonly agent: string;
  readonly kind: "permission" | "question" | "plan";
  /** The agent's own verb phrase: "wants to run", "asks a question". */
  readonly asks: string;
  /** The dialog's own question line. */
  readonly question: string;
  /** The exact command, file or question an answer applies to, shown whole: never truncated. */
  readonly command: string;
  /** A diff, a new file's text, a plan, the answers about to be submitted. */
  readonly body: string;
  /** The agent's own lines above the dialog: what it is about to do and why. */
  readonly context: readonly string[];
  /** Files the dialog names. */
  readonly files: readonly string[];
  readonly multi: boolean;
  readonly options: readonly ApprovalOption[];
  readonly cancel?: { readonly key: string; readonly label: string };
  readonly step?: { readonly index: number; readonly count: number; readonly titles: readonly string[] };
}

/** What the person chose: one row, typed text for a row that takes it, the rows to leave checked, or the cancel. */
export type ApprovalChoice =
  | { readonly kind: "option"; readonly option: string }
  | { readonly kind: "text"; readonly option: string; readonly text: string }
  | { readonly kind: "checked"; readonly options: readonly string[] }
  | { readonly kind: "cancel" };

/**
 * waiting: answerable. sending: the host is checking the prompt is still on the live screen, then pressing the keys.
 * stale: the prompt went away before anything was pressed. answered: the keys were delivered, here or elsewhere, with
 * the answer in the agent's own words. failed: the answer broke off (a dropped connection) and nothing was pressed.
 * elsewhere: another answer holds the prompt now. unknown: the key press failed after it was sent, so it may have
 * reached the agent; nothing more is offered, since a second press could answer a later prompt.
 */
export type ApprovalBannerState =
  | { readonly kind: "waiting" }
  | { readonly kind: "sending"; readonly choice: ApprovalChoice }
  | { readonly kind: "stale" }
  | { readonly kind: "answered"; readonly label: string; readonly declined: boolean; readonly where: string }
  | { readonly kind: "failed"; readonly choice: ApprovalChoice }
  | { readonly kind: "elsewhere"; readonly where: string }
  | { readonly kind: "unknown" };

export interface ApprovalBannerProps {
  readonly prompt: ApprovalPrompt;
  readonly state: ApprovalBannerState;
  /** The directory the agent works in. */
  readonly cwd?: string;
  readonly onAnswer?: (choice: ApprovalChoice) => void;
  readonly onDismiss?: () => void;
  /** Opens a file the dialog names; files it cannot open are shown without a button. */
  readonly onOpenFile?: (path: string) => void;
  readonly canOpenFile?: (path: string) => boolean;
  readonly className?: string;
}

/** The answer in the agent's own words: a row's label, the checked rows, or the cancel. */
export function choiceLabel(prompt: ApprovalPrompt, choice: ApprovalChoice): string {
  const label = (id: string) => prompt.options.find((option) => option.id === id)?.label ?? id;
  switch (choice.kind) {
    case "option":
    case "text":
      return label(choice.option);
    case "checked":
      return choice.options.map(label).join(", ") || "None";
    case "cancel":
      return prompt.cancel?.label ?? "Cancel";
  }
}

const stepText = (step: NonNullable<ApprovalPrompt["step"]>) => {
  const title = step.titles[step.index - 1];
  return `Step ${step.index} of ${step.count}${title === undefined ? "" : ` · ${title}`}`;
};

/**
 * What a screen reader should hear for a state. The banner draws no live region of its own: the surface that pins it
 * keeps one polite region mounted (empty) for as long as the terminal is shown and writes this text into it, so a
 * prompt appearing, and each change after it, is announced.
 */
export function approvalAnnouncement(prompt: ApprovalPrompt, state: ApprovalBannerState): string {
  switch (state.kind) {
    case "waiting": {
      const step = prompt.step === undefined ? "" : ` ${stepText(prompt.step)}.`;
      const options = prompt.options.map((option) => option.label).join(", ");
      return `${prompt.agent} ${prompt.asks}: ${prompt.command}.${step} ${prompt.multi ? "Check any of" : "Choose"}: ${options}.`;
    }
    case "sending":
      return `Checking the prompt is still on screen, then answering ${choiceLabel(prompt, state.choice)}.`;
    case "stale":
      return "The prompt went away. Nothing was sent.";
    case "answered":
      return `Answered ${state.label}: ${prompt.command}, ${state.where}.`;
    case "failed":
      return "The answer did not go through. Nothing was confirmed sent.";
    case "elsewhere":
      return `${state.where}.`;
    case "unknown":
      return `The answer may have reached ${prompt.agent}. Check the terminal before answering again.`;
  }
}

const frame =
  "flex flex-col gap-2 rounded-lg border border-border bg-popover px-3 py-2.5 text-sm text-popover-foreground shadow-overlay coarse:gap-3 coarse:p-3";
const block =
  "m-0 rounded-md bg-raised px-2.5 py-1.5 font-mono text-[0.8125rem] leading-[1.45] break-all whitespace-pre-wrap text-foreground";
const chip = "[&>span]:border-current/30 [&>span]:bg-transparent [&>span]:text-current";

function Notice({
  prompt,
  icon,
  title,
  text,
  onDismiss,
  onRetry,
  className,
}: {
  readonly prompt: ApprovalPrompt;
  readonly icon: "muted" | "error";
  readonly title: string;
  readonly text: string;
  readonly onDismiss: (() => void) | undefined;
  readonly onRetry?: () => void;
  readonly className: string | undefined;
}) {
  return (
    <section aria-label={`${prompt.agent} prompt`} className={cn(frame, className)}>
      <div className="flex items-start gap-2.5">
        <CircleSlash
          aria-hidden
          className={cn("mt-0.5 size-4 shrink-0", icon === "error" ? "text-destructive" : "text-muted-foreground")}
        />
        <p className="min-w-0 flex-1 text-muted-foreground">
          <span className="font-semibold text-foreground">{title}</span> {text}
        </p>
        <div className="-my-1 flex shrink-0 gap-2">
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
          {onRetry === undefined ? null : (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}

/** The answer rows: one button per row in the agent's words with its key, a typed row opening a text box, or boxes. */
function Answers({
  prompt,
  sending,
  onAnswer,
}: {
  readonly prompt: ApprovalPrompt;
  readonly sending: ApprovalChoice | undefined;
  readonly onAnswer: ((choice: ApprovalChoice) => void) | undefined;
}) {
  const [typing, setTyping] = useState<string | undefined>(undefined);
  const typedId = useId();
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    () => new Set(prompt.options.filter((option) => option.checked === true).map((option) => option.id)),
  );
  const busy = sending !== undefined;
  const pressing = (option: ApprovalOption) =>
    sending !== undefined && sending.kind !== "checked" && sending.kind !== "cancel" && sending.option === option.id;

  const submitText = (event: FormEvent, option: ApprovalOption) => {
    event.preventDefault();
    if (text.trim() !== "") onAnswer?.({ kind: "text", option: option.id, text });
  };

  const boxes = prompt.options.filter((option) => option.checked !== undefined);
  const rows = prompt.options.filter((option) => option.checked === undefined);
  const firstAllow = boxes.length > 0 ? undefined : rows.find((option) => !option.declines && !option.typed)?.id;
  return (
    <div className="flex flex-col gap-1.5">
      {boxes.length === 0 ? null : (
        <fieldset className="flex flex-col gap-1" disabled={busy}>
          <legend className="sr-only">{prompt.question}</legend>
          {boxes.map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-raised px-2.5 py-1.5 hover:bg-selected"
            >
              <input
                type="checkbox"
                data-option={option.id}
                className="mt-0.5 size-4 accent-primary"
                checked={checked.has(option.id)}
                onChange={(event) => {
                  const next = new Set(checked);
                  if (event.target.checked) next.add(option.id);
                  else next.delete(option.id);
                  setChecked(next);
                }}
              />
              <span className="min-w-0 flex-1">
                <span className="text-foreground">{option.label}</span>
                {option.detail === undefined ? null : (
                  <span className="block text-xs text-muted-foreground">{option.detail}</span>
                )}
              </span>
            </label>
          ))}
          <Button
            variant="primary"
            size="sm"
            loading={sending?.kind === "checked"}
            disabled={busy}
            onClick={() => onAnswer?.({ kind: "checked", options: [...checked] })}
            className="self-end coarse:w-full"
          >
            Submit
          </Button>
        </fieldset>
      )}
      {rows.map((option) =>
        option.typed && typing === option.id ? (
          <form
            key={option.id}
            className="flex flex-wrap gap-x-2 gap-y-1"
            onSubmit={(event) => submitText(event, option)}
          >
            {/* The row's words stay readable while the answer is typed; the placeholder alone went with the first key (#1580). */}
            <label htmlFor={typedId} className={cn("basis-full", fieldLabelClass)}>
              {option.label}
            </label>
            <Input
              id={typedId}
              autoFocus
              value={text}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              className="h-(--control-sm) text-sm"
            />
            <Button type="submit" variant="primary" size="sm" loading={pressing(option)} disabled={busy}>
              <Send aria-hidden />
              Send
            </Button>
          </form>
        ) : (
          <Button
            key={option.id}
            data-option={option.id}
            variant={option.id === firstAllow ? "primary" : option.declines ? "ghost" : "secondary"}
            size="sm"
            loading={pressing(option)}
            disabled={busy && !pressing(option)}
            onClick={() => (option.typed ? setTyping(option.id) : onAnswer?.({ kind: "option", option: option.id }))}
            className="h-auto min-h-(--control-sm) justify-start py-1 text-left whitespace-normal"
          >
            {option.keys[0] === undefined ? null : <Kbd keys={[option.keys[0]]} className={chip} />}
            <span className="min-w-0 flex-1">
              {option.label}
              {option.detail === undefined ? null : (
                <span className="block text-xs font-normal opacity-75">{option.detail}</span>
              )}
            </span>
          </Button>
        ),
      )}
    </div>
  );
}

/**
 * Pinned over a terminal while its agent waits on a person: every row of its own dialog, in its own words, with what
 * it said above the dialog. The terminal below stays the source of truth.
 */
export function ApprovalBanner({
  prompt,
  state,
  cwd,
  onAnswer,
  onDismiss,
  onOpenFile,
  canOpenFile,
  className,
}: ApprovalBannerProps) {
  if (state.kind === "answered") {
    return (
      <section aria-label={`${prompt.agent} prompt`} className={cn(frame, "flex-row items-center gap-2.5", className)}>
        <Check aria-hidden className="size-4 shrink-0 text-foreground" />
        <p className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-foreground">{state.label}</span>
          <span className="ml-2 font-mono text-xs text-muted-foreground">{prompt.command}</span>
        </p>
        <span className="shrink-0 text-xs text-muted-foreground">{state.where}</span>
      </section>
    );
  }
  if (state.kind === "elsewhere") {
    return (
      <section aria-label={`${prompt.agent} prompt`} className={cn(frame, "flex-row items-center gap-2.5", className)}>
        <StatusIndicator status="working" />
        <p className="min-w-0 flex-1 truncate text-muted-foreground">
          <span className="font-semibold text-foreground">{state.where}</span>
          <span className="ml-2 font-mono text-xs">{prompt.command}</span>
        </p>
      </section>
    );
  }
  if (state.kind === "unknown")
    return (
      <Notice
        prompt={prompt}
        icon="muted"
        title="Not confirmed."
        text={`The answer may have reached ${prompt.agent}; check the terminal before answering again.`}
        onDismiss={onDismiss}
        className={className}
      />
    );
  if (state.kind === "failed") {
    const choice = state.choice;
    return (
      <Notice
        prompt={prompt}
        icon="error"
        title="The answer did not go through."
        text={`Nothing was confirmed sent; ${prompt.agent} is still asking.`}
        onDismiss={onDismiss}
        onRetry={() => onAnswer?.(choice)}
        className={className}
      />
    );
  }
  if (state.kind === "stale")
    return (
      <Notice
        prompt={prompt}
        icon="muted"
        title="The prompt went away."
        text={`Nothing was sent; the terminal shows what ${prompt.agent} is doing now.`}
        onDismiss={onDismiss}
        className={className}
      />
    );

  const sending = state.kind === "sending" ? state.choice : undefined;
  const asked = prompt.kind === "permission" ? undefined : prompt.question;
  return (
    <section aria-label={`${prompt.agent} ${prompt.asks}`} className={cn(frame, "overflow-y-auto", className)}>
      <div className="flex items-center gap-2.5">
        <StatusIndicator status="blocked" />
        <p className="min-w-0 flex-1 truncate text-muted-foreground">
          <span className="font-semibold text-foreground">{prompt.agent}</span> {prompt.asks}
        </p>
      </div>
      {prompt.step === undefined ? null : <p className="m-0 text-xs text-muted-foreground">{stepText(prompt.step)}</p>}
      {prompt.context.length === 0 ? null : (
        <div aria-label="What the agent said" className="border-l-2 border-border pl-2.5 text-xs text-muted-foreground">
          {prompt.context.map((line, index) => (
            <p key={index} className="m-0 break-words">
              {line}
            </p>
          ))}
        </div>
      )}
      {cwd === undefined || cwd === "" ? null : (
        <p className="m-0 truncate font-mono text-xs text-muted-foreground">in {cwd}</p>
      )}
      {asked === undefined ? (
        <pre className={block}>{prompt.command}</pre>
      ) : (
        <p className="m-0 font-medium text-pretty text-foreground">{asked}</p>
      )}
      {prompt.body === "" ? null : prompt.kind === "permission" && prompt.files.length === 0 ? (
        <p className="m-0 text-xs text-pretty text-muted-foreground">{prompt.body}</p>
      ) : (
        <pre className={cn(block, "max-h-48 overflow-auto text-xs")}>{prompt.body}</pre>
      )}
      {prompt.files.length === 0 ? null : (
        <div className="flex flex-wrap gap-1.5">
          {prompt.files.map((file) =>
            onOpenFile !== undefined && canOpenFile?.(file) !== false ? (
              <Button key={file} variant="ghost" size="sm" onClick={() => onOpenFile(file)} className="font-mono">
                <FileText aria-hidden />
                {file}
              </Button>
            ) : (
              <span key={file} className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                <FileText aria-hidden className="size-3.5" />
                {file}
              </span>
            ),
          )}
        </div>
      )}
      <Answers key={prompt.question + prompt.body} prompt={prompt} sending={sending} onAnswer={onAnswer} />
      {prompt.cancel === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          loading={sending?.kind === "cancel"}
          disabled={sending !== undefined}
          data-cancel
          onClick={() => onAnswer?.({ kind: "cancel" })}
          className="self-end"
        >
          {prompt.cancel.label}
          <Kbd keys={[prompt.cancel.key]} className={chip} />
        </Button>
      )}
      {sending === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          Checking the prompt is still on screen, then answering {choiceLabel(prompt, sending)}…
        </p>
      )}
    </section>
  );
}
