import type { Agent, Space, TerminalLine, WorkspaceTab } from "@doriface/ui";

/** Fixture data for the landing's app mockups: terminals and coding agents only, as the product is a terminal. */
export const SPACES: readonly Space[] = [
  { id: "api", name: "api-server", tabs: 3, attention: "blocked" },
  { id: "web", name: "web-client", tabs: 2, attention: "working" },
  { id: "infra", name: "infra", machine: "build-box", tabs: 1, attention: "done" },
  { id: "notes", name: "release-notes", tabs: 1, attention: "idle" },
];

export const AGENTS_NEEDS_YOU: readonly Agent[] = [
  { id: "a1", name: "OmO", detail: "approve migration", status: "blocked", age: "2m" },
];
export const AGENTS_DONE: readonly Agent[] = [
  { id: "a2", name: "Codex", detail: "sync tests", status: "done", age: "6m" },
];
export const AGENTS_WORKING: readonly Agent[] = [
  { id: "a3", name: "Claude Code", detail: "web-client", status: "working", age: "<1m" },
  { id: "a4", name: "Codex", detail: "terraform plan", status: "working", machine: "build-box", age: "12m" },
];
export const AGENTS_IDLE: readonly Agent[] = [
  { id: "a5", name: "shell", detail: "release-notes", status: "idle", age: "1h" },
];

export const TABS: readonly WorkspaceTab[] = [
  { id: "t1", title: "OmO", status: "blocked" },
  { id: "t2", title: "Codex", status: "done" },
  { id: "t3", title: "Claude Code", status: "working" },
];

export const OMO_LINES: readonly TerminalLine[] = [
  [{ text: "~/api-server ", color: 4 }, { text: "main", color: 5 }, { text: " $ omo" }],
  [{ text: "● ", color: 3 }, { text: "Reading migrations/0042_session_keys.sql" }],
  [{ text: "● ", color: 3 }, { text: "Running " }, { text: "bun test db/", bold: true }],
  [{ text: "  ✓ 41 passed", color: 2 }, { text: "  " }, { text: "1.82s", dim: true }],
  [],
  [{ text: "  This migration drops " }, { text: "sessions.legacy_token", color: 3 }, { text: "." }],
  [{ text: "  Existing rows lose their old tokens" }],
  [{ text: "  and must sign in again." }],
  [],
  [{ text: "  Apply the migration to the staging database?", bold: true }],
  [
    { text: "  ❯ ", color: 6 },
    { text: "1. Yes, apply it", color: 6 },
  ],
  [{ text: "    2. No, explain the rollback first" }],
];

export const CODEX_LINES: readonly TerminalLine[] = [
  [{ text: "~/api-server ", color: 4 }, { text: "sync", color: 5 }, { text: " $ codex" }],
  [{ text: "• ", color: 4 }, { text: "Ran " }, { text: "bun test src/sync", bold: true }],
  [],
  [{ text: " PASS ", color: 2, bold: true }, { text: " src/sync/queue.test.ts" }],
  [{ text: " PASS ", color: 2, bold: true }, { text: " src/sync/retry.test.ts" }],
  [{ text: " PASS ", color: 2, bold: true }, { text: " src/sync/limit.test.ts" }],
  [],
  [{ text: "Tests  " }, { text: "27 passed", color: 2 }, { text: " (27)" }],
  [{ text: "Time   3.18s", dim: true }],
  [],
  [{ text: "✓ Done.", color: 2 }],
  [{ text: "codex › ", color: 8 }],
];
