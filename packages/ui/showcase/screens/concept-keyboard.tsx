import { List, Minus, Plus } from "lucide-react";

import { cn } from "../../src/index.ts";
import { Caption, Chip, Group, Hero, RealBar, Row, Toolbar } from "./concept-keyboard-parts.tsx";
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
  if (concept === "c") return <ConceptC editing={editing} />;
  return <ConceptA editing={editing} />;
}
