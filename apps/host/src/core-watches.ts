import { endSweeper } from "./end-sweeper.ts";
import type { HcTarget } from "./mesh/hc-machines.ts";
import { meshProgram } from "./mesh/program.ts";
import { resumeWatch } from "./resume/resume-watch.ts";
import { type RunTokens, runTokens } from "./resume/run-tokens.ts";

export interface CoreWatches {
  /** Opens every watch that is not open, as a client connects: a watch whose core restarted is opened again. */
  ensure(): void;
  /** The OSC 7577 token hook for one client connection; undefined while program resume is off. */
  readonly runTokens: (() => RunTokens) | undefined;
  stop(): Promise<void>;
}

export interface CoreWatchOptions {
  readonly stateDir?: string | undefined;
  readonly resume?: boolean | undefined;
  readonly log: (line: string) => void;
}

/**
 * The host's own watches over its core, each on an `hc connect` of its own: the end sweeper, and (with a state dir,
 * unless turned off) program resume. Resume is never on as root, where a resumed command would run with root's rights,
 * or on Windows, which this host's resume does not cover yet.
 */
export function coreWatches(
  core: HcTarget,
  options: CoreWatchOptions,
  started: (name: string, stop: () => unknown, kill?: () => readonly string[]) => void,
): CoreWatches {
  const ends = endSweeper(core, options.log);
  started(
    "end sweeper",
    () => ends.stop(),
    () => ends.kill().map((pid) => `hc connect pid ${pid}`),
  );
  const { stateDir } = options;
  const resume =
    stateDir === undefined || options.resume === false || process.platform === "win32" || process.getuid?.() === 0
      ? undefined
      : resumeWatch({ core, stateDir, program: meshProgram(stateDir), log: options.log });
  if (resume !== undefined) {
    started(
      "resume watch",
      () => resume.stop(),
      () => resume.kill().map((pid) => `hc connect pid ${pid}`),
    );
  }
  return {
    ensure: () => {
      void ends.ensure();
      void resume?.ensure();
    },
    runTokens: resume === undefined ? undefined : () => runTokens((run) => resume.started(run)),
    stop: async () => {
      await Promise.all([ends.stop(), resume?.stop()]);
    },
  };
}
