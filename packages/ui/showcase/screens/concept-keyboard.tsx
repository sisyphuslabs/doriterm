import {
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  GamepadDirectional,
  KeyboardOff,
  List,
  Minus,
  Plus,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../src/index.ts";

/** Concept renders for Settings ▸ Keyboard. NOT PRODUCT CODE: a scratch screen for the owner to pick a direction. */

const KEYS = ["ctrl", "cmd", "shift", "alt", "tab", "esc", "^C", "←", "↑", "↓", "→", "~", "|", "/", "-"] as const;
const LATENT = new Set(["ctrl"]);

const KEY = "flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full px-1.5 text-[0.8125rem] font-medium";
const LATCHED = "bg-primary font-semibold text-primary-foreground";
const IDLE = "text-foreground";

function BarKey({
  label,
  editing,
  lifted,
}: {
  readonly label: string;
  readonly editing: boolean;
  readonly lifted?: boolean;
}) {
  const latched = LATENT.has(label);
  return (
    <span className="relative shrink-0">
      {editing ? (
        <span
          aria-hidden
          className="absolute top-0.5 left-0.5 z-10 flex size-4 items-center justify-center rounded-full bg-destructive text-background"
        >
          <Minus className="size-2.5" />
        </span>
      ) : null}
      <span
        className={cn(
          KEY,
          latched ? LATCHED : IDLE,
          lifted === true && "-translate-y-1 shadow-overlay",
          editing && "opacity-90",
        )}
      >
        {label}
      </span>
    </span>
  );
}

function RealBar({ editing = false }: { readonly editing?: boolean }) {
  return (
    <div className="flex h-[3.25rem] items-center rounded-full border border-border bg-chrome/95 p-1 shadow-lg">
      <div className="flex min-w-0 flex-1 items-center overflow-hidden [mask-image:linear-gradient(to_right,black_calc(100%-1.25rem),transparent)]">
        {KEYS.slice(0, 7).map((label) => (
          <BarKey key={label} label={label} editing={editing} lifted={editing && label === "tab"} />
        ))}
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
        <BarKey label="←" editing={editing} />
        <BarKey label="↑" editing={editing} />
        <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
        <span className={cn(KEY, IDLE)}>
          <GamepadDirectional className="size-5" />
        </span>
        <span className={cn(KEY, IDLE)}>
          <List className="size-5" />
        </span>
        <span className={cn(KEY, IDLE)}>
          <ClipboardPaste className="size-5" />
        </span>
      </div>
      <span aria-hidden className="mx-1 h-6 w-px shrink-0 bg-border" />
      <div className="flex shrink-0 items-center">
        <span className="mx-1 flex h-9 w-[7.5rem] items-center rounded-full border border-input px-3 text-xs text-muted-foreground">
          Type
        </span>
        <span className={cn(KEY, IDLE)}>
          <KeyboardOff className="size-5" />
        </span>
      </div>
    </div>
  );
}

function Hero({ editing = false, hint }: { readonly editing?: boolean; readonly hint: string }) {
  return (
    <div className="border-y border-border bg-card px-2 pt-3 pb-2">
      <p className="px-2 pb-2 font-mono text-[0.6875rem] text-muted-foreground">$ herdr --agent</p>
      <RealBar editing={editing} />
      <p className="px-2 pt-2 text-[0.6875rem] text-muted-foreground">{hint}</p>
    </div>
  );
}

function Toolbar({ action }: { readonly action: ReactNode }) {
  return (
    <header data-titlebar className="flex h-12 items-center gap-1 border-b border-border px-2">
      <span className="flex size-11 items-center justify-center rounded-full text-foreground">
        <ChevronLeft className="size-5" />
      </span>
      <span className="flex-1 text-base font-semibold text-foreground">Keyboard</span>
      {action}
    </header>
  );
}

function Group({ children }: { readonly children: ReactNode }) {
  return <div className="overflow-hidden rounded-lg border border-border bg-card">{children}</div>;
}

function Row({
  title,
  value,
  last = false,
}: {
  readonly title: string;
  readonly value: string;
  readonly last?: boolean;
}) {
  return (
    <div className={cn("flex min-h-12 items-center gap-2 px-4", !last && "border-b border-border")}>
      <span className="flex-1 text-base text-foreground">{title}</span>
      <span className="text-sm text-muted-foreground">{value}</span>
      <ChevronRight className="size-4 text-muted-foreground" />
    </div>
  );
}

function Chip({
  label,
  on = false,
  muted = false,
}: {
  readonly label: string;
  readonly on?: boolean;
  readonly muted?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex h-9 items-center rounded-full border px-3 text-[0.8125rem] font-medium",
        on ? "border-transparent bg-primary text-primary-foreground" : "border-border text-foreground",
        muted && "opacity-45",
      )}
    >
      {label}
    </span>
  );
}

function Caption({ children }: { readonly children: ReactNode }) {
  return <p className="px-1 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{children}</p>;
}

/** A. The live bar is the hero; three grouped rows open sheets; Edit turns the screen into the iOS-style editor. */
function ConceptA({ editing }: { readonly editing: boolean }) {
  return (
    <div className="flex h-[844px] w-[390px] flex-col bg-background">
      <Toolbar
        action={
          <span
            className={cn(
              "flex h-9 items-center rounded-full px-3 text-sm font-semibold",
              editing ? "bg-primary text-primary-foreground" : "text-brand",
            )}
          >
            {editing ? "Done" : "Edit"}
          </span>
        }
      />
      <div className="flex flex-1 flex-col gap-6 overflow-hidden px-4 pt-4">
        <Hero
          editing={false}
          hint={editing ? "Drag to reorder. − takes a key out." : "This is your bar in every terminal."}
        />
        {editing ? (
          <div className="flex flex-col gap-2">
            <Caption>In the bar</Caption>
            <Group>
              {["ctrl", "shift", "tab", "esc", "^C"].map((label) => (
                <div
                  key={label}
                  className="flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0"
                >
                  <span className="flex size-5 items-center justify-center rounded-full bg-destructive text-background">
                    <Minus className="size-3" />
                  </span>
                  <span className="flex-1 text-base text-foreground">{label}</span>
                  <span className="text-muted-foreground">
                    <List className="size-4" />
                  </span>
                </div>
              ))}
            </Group>
            <Caption>More keys</Caption>
            <Group>
              {["alt", "home", "end", "pgup", "pgdn"].map((label) => (
                <div
                  key={label}
                  className="flex min-h-12 items-center gap-3 border-b border-border px-3 last:border-b-0"
                >
                  <span className="flex size-5 items-center justify-center rounded-full bg-brand text-brand-foreground">
                    <Plus className="size-3" />
                  </span>
                  <span className="flex-1 text-base text-foreground">{label}</span>
                </div>
              ))}
            </Group>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Caption>Bar</Caption>
            <Group>
              <Row title="Keys" value="15 shown" />
              <Row title="Packs" value="Tmux on" />
              <Row title="Your keys" value="2" last />
            </Group>
            <p className="px-1 text-xs text-muted-foreground">Hold Ctrl in a terminal to switch packs.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** B. Scoped tabs under a pinned bar: keys are chips you tap, order changes only in Edit. */
function ConceptB({ editing }: { readonly editing: boolean }) {
  return (
    <div className="flex h-[844px] w-[390px] flex-col bg-background">
      <Toolbar
        action={
          <span
            className={cn(
              "flex h-9 items-center px-3 text-sm font-semibold",
              editing ? "text-foreground" : "text-brand",
            )}
          >
            {editing ? "Done" : "Edit"}
          </span>
        }
      />
      <Hero editing={editing} hint="Packs lead the bar; your keys follow." />
      <div className="flex flex-col gap-4 px-4 pt-4">
        <div className="flex rounded-md border border-border bg-hover p-0.5 text-sm">
          {["Bar", "Packs", "Your keys"].map((scope, index) => (
            <span
              key={scope}
              className={cn(
                "flex h-9 flex-1 items-center justify-center rounded-sm",
                index === 0 ? "bg-popover text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              {scope}
            </span>
          ))}
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            {["ctrl", "shift", "alt", "tab", "esc", "^C"].map((label) => (
              <Chip key={label} label={label} on />
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Caption>Navigation</Caption>
            <div className="flex flex-wrap gap-1.5">
              {["←", "↑", "↓", "→", "home", "end", "pgup", "pgdn"].map((label) => (
                <Chip key={label} label={label} on />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Caption>Symbols</Caption>
            <div className="flex flex-wrap gap-1.5">
              {["~", "|", "/", "-", "cmd"].map((label) => (
                <Chip key={label} label={label} on={label !== "cmd"} />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Plus className="size-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Add from the full list</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** C. Settings as an overlay on the terminal: the bar docks on a live screen, and a sheet holds the picker. */
function ConceptC({ editing }: { readonly editing: boolean }) {
  return (
    <div className="relative flex h-[844px] w-[390px] flex-col overflow-hidden bg-card">
      <Toolbar
        action={
          <span
            className={cn(
              "flex h-9 items-center px-3 text-sm font-semibold",
              editing ? "text-foreground" : "text-brand",
            )}
          >
            {editing ? "Done" : "Edit"}
          </span>
        }
      />
      <div className="flex flex-1 flex-col justify-between pb-[430px]">
        <div className="flex flex-col gap-1.5 px-4 pt-4 font-mono text-[0.75rem] leading-relaxed">
          <p className="text-muted-foreground">$ bun test packages/ui</p>
          <p className="text-foreground">✓ 412 pass</p>
          <p className="text-muted-foreground">$ git status</p>
          <p className="text-foreground">On branch feat/mobile-keymap</p>
          <p className="text-muted-foreground">nothing to commit</p>
        </div>
        <div className="px-1.5">
          <RealBar editing={editing} />
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0">
        <div className="rounded-t-xl border-t border-border bg-popover pb-2 shadow-overlay">
          <div className="flex items-center gap-2 px-4 pt-3 pb-1">
            <span className="flex-1 text-base font-semibold text-foreground">Add keys</span>
            <span className="flex h-9 items-center rounded-full px-3 text-sm font-semibold text-brand">Done</span>
          </div>
          <div className="flex flex-col gap-4 px-4 py-3">
            {[
              { group: "Modifiers", keys: ["ctrl", "shift", "alt", "cmd"], on: ["ctrl", "shift", "alt", "cmd"] },
              {
                group: "Navigation",
                keys: ["←", "↑", "↓", "→", "home", "end", "pgup", "pgdn"],
                on: ["←", "↑", "↓", "→"],
              },
              { group: "Symbols", keys: ["~", "|", "/", "-"], on: ["~", "|", "/", "-"] },
              { group: "Packs", keys: ["Tmux", "Navigation", "Ctrl chords", "Agents"], on: ["Tmux"] },
            ].map((row) => (
              <div key={row.group} className="flex flex-col gap-1.5">
                <Caption>{row.group}</Caption>
                <div className="flex flex-wrap gap-1.5">
                  {row.keys.map((label) => (
                    <Chip key={label} label={label} on={row.on.includes(label)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ConceptKeyboardScreen() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const concept = params.get("concept") ?? "a";
  const editing = params.get("state") === "edit";
  if (concept === "b") return <ConceptB editing={editing} />;
  if (concept === "c") return <ConceptC editing={editing} />;
  return <ConceptA editing={editing} />;
}
