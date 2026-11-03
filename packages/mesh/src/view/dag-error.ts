export type DagProblem = "duplicate id" | "found count" | "dangling prev" | "unknown id";

export class DagError extends Error {
  readonly problem: DagProblem;

  constructor(problem: DagProblem, detail: string) {
    super(`${problem}: ${detail}`);
    this.problem = problem;
  }
}
