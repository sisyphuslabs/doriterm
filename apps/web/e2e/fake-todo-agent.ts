// `bun e2e/fake-todo-agent.ts [omp]`: a program that keeps a task list the way Claude Code does under hc (#673). It reports its
// status over OSC 7501 as `app: claude-code`, with the progress Claude Code sends as each task moves, and draws Claude
// Code's own screens (2.1.311, recorded from real sessions) to the terminal's width. Each `n` it receives moves to the
// next screen: four tasks with two done, twelve with five done (the rest folded), three all done and the turn over, then
// a screen with no list at all. `omp` draws omp's own TODO list (18.17.0) once, reporting as `app: omp`.
import {
  CLAUDE_NO_TASKS_SCREEN,
  CLAUDE_TASKS_DONE_SCREEN,
  CLAUDE_TASKS_FOLDED_SCREEN,
  CLAUDE_TASKS_WORKING_SCREEN,
  OMP_TODO_SCREEN,
} from "../../../packages/protocol/src/testing/todo-screens.ts";

const ESC = "\u001B";
const report = (fields: string) => process.stdout.write(`${ESC}]7501;${fields}${ESC}\\`);
const width = () => Math.max(20, (process.stdout.columns ?? 80) - 1);
const fit = (line: string) =>
  /^\s*([─╌])\1+$/.test(line) ? (line.trim()[0] ?? "─").repeat(width()) : line.slice(0, width());
/** A recorded screen from the person's message down, without the agent's banner. */
const draw = (screen: string) => {
  const lines = screen.split("\n");
  const rows = lines.slice(
    Math.max(
      0,
      lines.findIndex((line) => /^[❯ ] Do the task\.$/u.test(line)),
    ),
  );
  process.stdout.write(`${ESC}[2J${ESC}[H${rows.map(fit).join("\r\n")}`);
};

const CLAUDE_STEPS: readonly (readonly [string, string])[] = [
  [CLAUDE_TASKS_WORKING_SCREEN, "state=working:progress=50:app=claude-code"],
  [CLAUDE_TASKS_FOLDED_SCREEN, "state=working:progress=42:app=claude-code"],
  [CLAUDE_TASKS_DONE_SCREEN, "state=done:app=claude-code"],
  [CLAUDE_NO_TASKS_SCREEN, "state=idle:app=claude-code"],
];

const OMP_STEPS: readonly (readonly [string, string])[] = [[OMP_TODO_SCREEN, "state=working:app=omp"]];

const STEPS = process.argv[2] === "omp" ? OMP_STEPS : CLAUDE_STEPS;
let at = 0;
const show = () => {
  const [screen, status] = STEPS[at] ?? STEPS[0] ?? ["", ""];
  draw(screen);
  report(status);
};
show();

process.stdin.setRawMode(true);
process.stdin.on("data", (bytes: Buffer) => {
  if (!bytes.toString("utf8").includes("n") || at >= STEPS.length - 1) return;
  at += 1;
  show();
});
