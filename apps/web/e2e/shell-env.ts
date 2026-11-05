import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** A POSIX fixture shell, including after a login profile has replaced the inherited PS1 on macOS. */
export function shellEnv(dir: string): Readonly<Record<string, string>> {
  const rc = join(dir, "shellrc");
  writeFileSync(rc, "PS1='$ '\nunset PROMPT_COMMAND\n");
  return {
    SHELL: "/bin/sh",
    PS1: "$ ",
    ENV: rc,
    BASH_SILENCE_DEPRECATION_WARNING: "1",
  };
}
