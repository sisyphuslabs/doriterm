import type {
  Agent,
  ApprovalOption,
  ApprovalPrompt,
  Command,
  Space,
  TerminalLine,
  WorkspaceTab,
} from "../src/index.ts";

export const SPACES: readonly Space[] = [
  { id: "api", name: "api-server", tabs: 3, attention: "blocked" },
  { id: "web", name: "web-client", tabs: 2, attention: "working" },
  { id: "infra", name: "infra", machine: "build-box", tabs: 1, attention: "done" },
  { id: "notes", name: "release-notes", tabs: 1, attention: "idle" },
];

export const AGENTS_NEEDS_YOU: readonly Agent[] = [
  { id: "a1", name: "Claude Code", detail: "approve migration", status: "blocked", age: "2m" },
];
export const AGENTS_DONE: readonly Agent[] = [
  { id: "a2", name: "Codex", detail: "file sync tests", status: "done", age: "6m" },
];
export const AGENTS_WORKING: readonly Agent[] = [
  { id: "a3", name: "Claude Code", detail: "web-client", status: "working", age: "<1m" },
  { id: "a4", name: "Codex", detail: "terraform plan", status: "working", machine: "build-box", age: "12m" },
];
export const AGENTS_IDLE: readonly Agent[] = [
  { id: "a5", name: "shell", detail: "release-notes", status: "idle", age: "1h" },
];

export const TABS: readonly WorkspaceTab[] = [
  { id: "t1", title: "Claude Code", status: "blocked" },
  { id: "t2", title: "Codex", status: "done" },
  { id: "t3", title: "shell", status: "idle" },
];

export const CLAUDE_LINES: readonly TerminalLine[] = [
  [{ text: "~/api-server ", color: 4 }, { text: "main", color: 5 }, { text: " $ claude" }],
  [{ text: "● ", color: 3 }, { text: "Reading migrations/0042_session_keys.sql" }],
  [{ text: "● ", color: 3 }, { text: "Running " }, { text: "bun test db/", bold: true }],
  [
    { text: "  ✓ 41 passed", color: 2 },
    { text: "  ", dim: true },
    { text: "1.82s", dim: true },
  ],
  [],
  [{ text: "  This migration drops ", dim: false }, { text: "sessions.legacy_token", color: 3 }, { text: "." }],
  [{ text: "  Existing rows lose their old tokens" }],
  [{ text: "  and must sign in again." }],
  [],
  [{ text: "  Apply the migration to the staging database?", bold: true }],
  [
    { text: "  ❯ ", color: 6 },
    { text: "1. Yes, apply it", color: 6 },
  ],
  [{ text: "    2. Yes, and don't ask again for migrations" }],
  [{ text: "    3. No, explain the rollback first" }],
];

export const CODEX_LINES: readonly TerminalLine[] = [
  [{ text: "~/api-server ", color: 4 }, { text: "sync", color: 5 }, { text: " $ codex" }],
  [{ text: "• ", color: 4 }, { text: "Implemented file sync with retry and rate limit" }],
  [{ text: "• ", color: 4 }, { text: "Ran " }, { text: "bun test src/sync", bold: true }],
  [],
  [{ text: " PASS ", color: 2, bold: true }, { text: " src/sync/queue.test.ts" }],
  [{ text: " PASS ", color: 2, bold: true }, { text: " src/sync/retry.test.ts" }],
  [{ text: " PASS ", color: 2, bold: true }, { text: " src/sync/limit.test.ts" }],
  [],
  [{ text: "Tests  " }, { text: "27 passed", color: 2 }, { text: " (27)" }],
  [{ text: "Time   3.18s", dim: true }],
  [],
  [{ text: "✓ Done. ", color: 2 }, { text: "4 files changed, +212 −38" }],
  [{ text: "codex › ", color: 8 }],
];

export const COMMANDS: readonly Command[] = [
  { id: "go-claude", group: "Agents", label: "Claude Code · approve migration", status: "blocked" },
  { id: "go-codex", group: "Agents", label: "Codex · file sync tests", status: "done" },
  { id: "go-tf", group: "Agents", label: "Codex · terraform plan", hint: "build-box", status: "working" },
  { id: "new-tab", group: "Actions", label: "New tab", keys: ["⌘", "T"] },
  { id: "split", group: "Actions", label: "Split pane right", keys: ["⌘", "D"] },
  { id: "sidebar", group: "Actions", label: "Toggle sidebar", keys: ["⌘", "B"] },
  { id: "pair", group: "Hosts", label: "Pair a new host" },
  { id: "settings", group: "General", label: "Open settings", keys: ["⌘", ","] },
];

/** A deterministic module grid with QR finder patterns, for drawing only. It encodes nothing. */
export function sampleQrModules(size = 29): boolean[][] {
  const finder = (x: number, y: number): boolean | undefined => {
    for (const [ox, oy] of [
      [0, 0],
      [size - 7, 0],
      [0, size - 7],
    ] as const) {
      const dx = x - ox;
      const dy = y - oy;
      if (dx >= -1 && dx <= 7 && dy >= -1 && dy <= 7) {
        if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return false;
        const edge = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        return edge !== 2;
      }
    }
    return undefined;
  };
  let seed = 7;
  return Array.from({ length: size }, (_row, y) =>
    Array.from({ length: size }, (_cell, x) => {
      const fixed = finder(x, y);
      if (fixed !== undefined) return fixed;
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 7 < 3;
    }),
  );
}

/** Claude Code waiting on a Bash permission prompt, the screen the approval banner is pinned over. */
export const CLAUDE_PERMISSION_LINES: readonly TerminalLine[] = [
  [{ text: "~/api-server ", color: 4 }, { text: "main", color: 5 }, { text: " $ claude" }],
  [{ text: "● ", color: 3 }, { text: "Reading migrations/0042_session_keys.sql" }],
  [{ text: "● ", color: 3 }, { text: "Bash", bold: true }, { text: "(bun run db:migrate --env staging)" }],
  [],
  [{ text: " Bash command", bold: true }],
  [{ text: "   bun run db:migrate --env staging" }],
  [{ text: "   Apply migration 0042 to the staging database", dim: true }],
  [],
  [{ text: " Do you want to proceed?" }],
  [
    { text: " ❯ ", color: 6 },
    { text: "1. Yes", color: 6 },
  ],
  [{ text: "   2. Yes, and don't ask again for bun run db:migrate commands in ~/api-server" }],
  [{ text: "   3. No, and tell Claude what to do differently " }, { text: "(esc)", dim: true }],
];

/** The same session after the prompt was answered: the migration ran and Claude Code moved on. */
export const CLAUDE_ALLOWED_LINES: readonly TerminalLine[] = [
  [{ text: "~/api-server ", color: 4 }, { text: "main", color: 5 }, { text: " $ claude" }],
  [{ text: "● ", color: 3 }, { text: "Reading migrations/0042_session_keys.sql" }],
  [{ text: "● ", color: 3 }, { text: "Bash", bold: true }, { text: "(bun run db:migrate --env staging)" }],
  [
    { text: "  ⎿  ", dim: true },
    { text: "Applied 0042_session_keys.sql", color: 2 },
    { text: "  312ms", dim: true },
  ],
  [{ text: "● ", color: 3 }, { text: "Running " }, { text: "bun test db/", bold: true }],
];

/** The prompt left the screen before the banner's key went in: someone answered No in the terminal itself. */
export const CLAUDE_PROMPT_GONE_LINES: readonly TerminalLine[] = [
  [{ text: "~/api-server ", color: 4 }, { text: "main", color: 5 }, { text: " $ claude" }],
  [{ text: "● ", color: 3 }, { text: "Reading migrations/0042_session_keys.sql" }],
  [{ text: "● ", color: 3 }, { text: "Bash", bold: true }, { text: "(bun run db:migrate --env staging)" }],
  [
    { text: "  ⎿  ", dim: true },
    { text: "No (tell Claude what to do differently)", color: 1 },
  ],
  [],
  [{ text: "> ", color: 8 }, { text: "show me the rollback script first" }],
];

const row = (id: string, label: string, more: Partial<ApprovalOption> = {}): ApprovalOption => ({
  id,
  label,
  keys: [id],
  declines: false,
  typed: false,
  ...more,
});

/** Claude Code's Bash permission dialog, every row as it draws them. */
export const APPROVAL_PROMPT: ApprovalPrompt = {
  agent: "Claude Code",
  kind: "permission",
  asks: "wants to run",
  question: "Do you want to proceed?",
  command: "bun run db:migrate --env staging",
  body: "Apply the session-keys migration to staging",
  context: [
    "● Reading migrations/0042_session_keys.sql",
    "● The migration adds the session_keys table; I'll apply it to staging.",
  ],
  files: [],
  multi: false,
  options: [
    row("1", "Yes"),
    row("2", "Yes, and don't ask again for bun run db:migrate commands in ~/api-server"),
    row("3", "No", { declines: true }),
  ],
  cancel: { key: "esc", label: "Cancel" },
};

/** Claude Code asking the first of two questions, with a typed answer. */
export const QUESTION_PROMPT: ApprovalPrompt = {
  agent: "Claude Code",
  kind: "question",
  asks: "asks a question",
  question: "Which database should the migration target?",
  command: "Which database should the migration target?",
  body: "",
  context: ["● I need to know which database to use before I write the migration."],
  files: [],
  multi: false,
  options: [
    row("1", "Postgres", { detail: "The production database" }),
    row("2", "SQLite", { detail: "The local test database" }),
    row("3", "Type something.", { typed: true }),
    row("4", "Chat about this"),
  ],
  cancel: { key: "esc", label: "Cancel" },
  step: { index: 1, count: 3, titles: ["Database", "Deploy", "Submit"] },
};

/** Claude Code asking a multi-select question. */
export const MULTI_PROMPT: ApprovalPrompt = {
  ...QUESTION_PROMPT,
  question: "Which checks should CI run on every push?",
  command: "Which checks should CI run on every push?",
  context: ["● I can add several checks to CI."],
  multi: true,
  options: [
    row("1", "Lint", { detail: "oxlint over the repo", checked: true }),
    row("2", "Typecheck", { detail: "tsc -b", checked: false }),
    row("3", "Unit tests", { detail: "bun test", checked: false }),
    row("5", "Chat about this"),
  ],
  step: { index: 1, count: 2, titles: ["CI checks", "Submit"] },
};

/** Claude Code asking to edit a file, with its diff. */
export const EDIT_PROMPT: ApprovalPrompt = {
  ...APPROVAL_PROMPT,
  asks: "wants to edit",
  question: "Do you want to make this edit to migrations/0042_session_keys.sql?",
  command: "migrations/0042_session_keys.sql",
  body: "12  CREATE TABLE session_keys (\n13 -  id TEXT PRIMARY KEY\n13 +  id TEXT PRIMARY KEY,\n14 +  expires_at INTEGER NOT NULL",
  context: ["● The table needs an expiry column.", "● Update(migrations/0042_session_keys.sql)"],
  files: ["migrations/0042_session_keys.sql"],
  options: [
    row("1", "Yes"),
    row("2", "Yes, and switch to accept edits for this session (shift+tab)"),
    row("3", "No", { declines: true }),
  ],
};

/** Claude Code in plan mode asking to approve its plan. */
export const PLAN_PROMPT: ApprovalPrompt = {
  agent: "Claude Code",
  kind: "plan",
  asks: "has a plan ready",
  question: "Claude has written up a plan and is ready to execute. Would you like to proceed?",
  command: "Add the users migration",
  body: "Add the users migration\n\n1. Add migrations/004_users.sql with the users table.\n2. Run it against SQLite in bun test.\n3. Note the new table in README.md.",
  context: ["● The plan is ready."],
  files: ["~/.claude/plans/users-migration.md"],
  multi: false,
  options: [
    row("1", "Yes, and use auto mode"),
    row("2", "Yes, manually approve edits"),
    row("3", "Tell Claude what to change", { typed: true }),
  ],
  cancel: { key: "esc", label: "Cancel" },
};

/** A Korean and an English sentence, as the dictation acceptance criteria ask. */
export const VOICE_TRANSCRIPT = "마이그레이션 롤백 스크립트부터 보여줘. Then run the db tests again.";

/** What the recognizer has heard so far, mid-sentence, for a still frame of listening. */
export const VOICE_HEARD = "마이그레이션 롤백 스크립트부터 보여줘. Then run the";

interface SampleMcpClient {
  readonly id: string;
  readonly name: string;
  readonly connected: string;
  readonly deviceId: string;
  readonly paired: string;
}

/** Sample connected MCP clients for Settings > MCP clients. */
export const MCP_CLIENTS: readonly SampleMcpClient[] = [
  {
    id: "c1",
    name: "Grok bot",
    connected: "Connected 3 minutes ago",
    deviceId: "3FA94C0E",
    paired: "Paired 18 Dec",
  },
  {
    id: "c2",
    name: "Dots",
    connected: "Connected 2 hours ago",
    deviceId: "7B21D855",
    paired: "Paired 11 Dec",
  },
];
