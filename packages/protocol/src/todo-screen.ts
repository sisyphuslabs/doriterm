/** How far an agent's own todo list has got: `done` of `total` items. */
export interface TodoProgress {
  readonly done: number;
  readonly total: number;
}

type TodoReader = (lines: readonly string[]) => TodoProgress | undefined;

/** A task row of Claude Code's list (✔ done, ◼ in progress, ◻ open), the first one hung off the spinner by `⎿`. */
const CLAUDE_ROW = /^\s*(?:⎿\s+)?([✔◼◻])\s+\S/u;
/** The line a long list folds into: `… +1 in progress, 6 pending`. */
const CLAUDE_FOLD = /^\s*…\s*\+(.+)$/u;
/** The count line over the list once the turn is over: `4 tasks (2 done, 1 in progress, 1 open)`. */
const CLAUDE_COUNT = /^\s*(\d+) tasks? \((\d+) done\b/u;
/**
 * The spinner line the list hangs off while the agent works: `✶ Running the suite… (13s · ↓ 162 tokens)`. Its timer can
 * sit anywhere in the parentheses and grows past a minute: `(1m 21s · …)`, `(esc to interrupt · 1h 2m 3s · …)`.
 */
const CLAUDE_SPINNER = /^\S\s.*…\s*\([^)]*\b\d+s\b/u;
/** The list's first row while the agent works, hung off the spinner line. */
const CLAUDE_HUNG_ROW = /^\s*⎿\s+[✔◼◻]\s/u;
const DONE_WORDS = /^(?:completed|done)$/u;

/** The folded line's counts: every number toward the total, the done ones toward done. */
function foldCounts(fold: string): TodoProgress {
  let done = 0;
  let total = 0;
  for (const part of fold.split(",")) {
    const match = /(\d+)\s+(.+)/u.exec(part.trim().replace(/^\+/u, ""));
    if (match === null) continue;
    const count = Number(match[1]);
    total += count;
    if (DONE_WORDS.test((match[2] ?? "").trim())) done += count;
  }
  return { done, total };
}

/**
 * Claude Code's task list (TaskCreate and TaskUpdate), the last one on the screen: its count line when it has one, else
 * its rows plus the line the rest folds into. Only a list Claude Code anchors counts: one under its count line, or one
 * hung off the spinner line by `⎿`. Check marks in a reply or in a tool's output under `⎿` have neither, and an
 * AskUserQuestion tab row (`←  ☐ Runtime  ✔ Submit  →`) is not a row.
 */
const readClaudeTodos: TodoReader = (lines) => {
  let end = lines.length - 1;
  while (end >= 0) {
    if (!CLAUDE_ROW.test(lines[end] ?? "")) {
      end -= 1;
      continue;
    }
    let start = end;
    while (start > 0 && CLAUDE_ROW.test(lines[start - 1] ?? "")) start -= 1;
    const above = lines[start - 1] ?? "";
    const count = CLAUDE_COUNT.exec(above);
    if (count !== null) return { done: Number(count[2]), total: Number(count[1]) };
    if (CLAUDE_SPINNER.test(above) && CLAUDE_HUNG_ROW.test(lines[start] ?? "")) {
      const rows = lines.slice(start, end + 1).map((line) => CLAUDE_ROW.exec(line)?.[1]);
      const fold = CLAUDE_FOLD.exec(lines[end + 1] ?? "");
      const folded = fold === null ? { done: 0, total: 0 } : foldCounts(fold[1] ?? "");
      return {
        done: rows.filter((mark) => mark === "✔").length + folded.done,
        total: rows.length + folded.total,
      };
    }
    end = start - 1;
  }
  return undefined;
};

/** omp's TODO list over its editor: a `TODO` line, then each phase as a branch with its own `done/total`. */
const OMP_HEADER = /^\s*TODO\s*$/u;
/** A phase's branch, `├─ Work · 1/4` or numbered once there are several, `├─ II. Ship · 1/3`; a folded phase keeps it. */
const OMP_PHASE = /^\s*[├└]─\s+.+?\s+·\s+(\d+)\/(\d+)\s*$/u;
/** Any line of the tree: a branch, a task under a phase, or the closing rule. */
const OMP_TREE = /^\s*[│├└]/u;

/** omp's list, the last one on the screen: the phases' counts added up. */
const readOmpTodos: TodoReader = (lines) => {
  let header = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (OMP_HEADER.test(lines[index] ?? "")) {
      header = index;
      break;
    }
  }
  if (header === -1) return undefined;
  let done = 0;
  let total = 0;
  for (const line of lines.slice(header + 1)) {
    if (!OMP_TREE.test(line)) break;
    const phase = OMP_PHASE.exec(line);
    if (phase === null) continue;
    done += Number(phase[1]);
    total += Number(phase[2]);
  }
  return total === 0 ? undefined : { done, total };
};

/** Readers by the `app` an agent names itself in its OSC 7501 record; another agent has no list here. */
const READERS: Readonly<Record<string, TodoReader>> = {
  "claude-code": readClaudeTodos,
  omp: readOmpTodos,
};

/** Whether the agent that reported `app` draws a todo list this reads. */
export const readsTodos = (app: string): boolean => Object.hasOwn(READERS, app);

/** The agent's todo list on a `terminal.read` screen, read by the reader of the agent that reported `app`, or nothing. */
export function readTodoProgress(app: string, screen: string): TodoProgress | undefined {
  const reader = Object.hasOwn(READERS, app) ? READERS[app] : undefined;
  return reader?.(screen.split("\n").map((line) => line.trimEnd()));
}
