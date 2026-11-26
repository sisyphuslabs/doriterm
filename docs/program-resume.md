# Program resume (OSC 7577)

Doriterm supports the terminal side of the [Program Resume Protocol](https://www.superlogical.com/rex/docs/build/program-resume)
(OSC 7577, revision 0.5). A program running in a Doriterm terminal can tell Doriterm how to bring it back, for example an
editor with its session file or an agent with its session id. After the core restarts or the machine reboots, Doriterm
starts that command again.

The host (`doriface-host`) implements it, because the host is the one part of Doriterm that sees a client's
`terminal.run` and that runs on the machine where the command will run again. Doriterm still never owns a PTY. The
core starts every program. The host adds a token to the run, watches the terminal's output for OSC 7577 reports only,
and later asks the core for a new terminal.

## What happens

1. A client starts a terminal on this machine's core. The host adds `OSC7577_TOKEN` to that run's environment: 32
   characters of `[A-Za-z0-9_-]` (192 random bits), new for every terminal and every start, so two terminals never share
   one. A run on another machine (`on`) gets no token. A token the client or the host's own environment carried is
   never passed on.
2. The host watches the terminal's output through an observe-only attach, which never types or resizes. It reads
   `ESC ] 7577 ; … ST` and nothing else.
3. Each report is checked in the spec's order:
   - The `mac` (SHA-256 of the body before `:mac=`, then `:`, then the token) and the `time` (within 60 s of the host's
     clock, and never earlier than the last accepted report of the same pid) come first. A report that fails either,
     was cut short, or is longer than 4096 bytes is **ignored**: it changes nothing, because nobody knows who sent it.
   - Strict parsing follows. A malformed or repeated pair, a bad value, a missing `argv` and `clear` (or both), a
     relative first element, a relative `cwd`, bad base64, text that is not UTF-8 or holds a control character, more
     than 128 elements, or an unimplemented `need` **rejects** the report. A rejection removes its owner's record.
   - The reported pid must be running, as the host's own user, and be the terminal's first process or one of its
     descendants. Otherwise the report is rejected.
4. An accepted report becomes the terminal's one record (the last write wins). It holds the argv, the cwd (the report's
   `cwd`, else the program's own directory read from the OS, never OSC 7), the pid with its start time, and the user.
   Records are written at once to `<state dir>/resume/resume.json`. The dir is 0700 and the file 0600, because a
   record is as sensitive as a shell startup file.
5. A record goes away:
   - on `clear=1` from its owner, or on a rejection;
   - when its owner exits while the terminal lives on (after a 2 s grace, so a program that exits as the terminal ends
     still comes back);
   - when the terminal itself ends for good (its program exited or was killed) or is removed.

   A record is kept when the core loses the terminal (`server_stop`, a shutdown, a crash). RIS, DECSTR, the alternate
   screen, erasing and OSC 133 never touch it.

6. When a client next connects after the core came back, every record whose terminal the core no longer runs is
   resumed once:
   - The record leaves the store before anything starts. A resume that fails, or crashes the host, is not tried again,
     and the resumed program must report again to be resumed again.
   - A new terminal starts with a **new** token under the old terminal's name, in the record's cwd.
   - When the program was not the terminal's first process, the terminal runs the user's own shell. After its startup
     files, the host types one fixed line at the first prompt: `'<host program>' resume-exec '<launch file>'`. The
     program then runs as that shell's foreground job, so Ctrl+Z and exiting land back in the shell. A program that was
     the first process starts as the first process again, through `$SHELL -i -c 'exec "$0" "$@"'` with the command as
     arguments, so the same startup files run first.
   - The command itself is in a one-use 0600 launch file, written only once the new terminal is watched. `resume-exec`
     waits for it, checks that it is this user's private file, deletes it, checks the user and the cwd, looks the
     program up on the shell's `PATH`, and starts it with each element as one argument. No byte of the command is ever
     shell source text, so `$(…)` and `a; b` stay text, and a shell function, alias or builtin of the same name cannot
     run in its place.

## Trust model

| Who                                                                                               | Can register a command?                                                 | Why                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Text a terminal shows (`cat`, logs, a recording, remote output over `ssh`)                        | No                                                                      | It does not know the token, and a replay ages out after 60 s            |
| A program on another machine (an added machine's terminal)                                        | No                                                                      | Runs on other machines get no token                                     |
| A program in the terminal, or another of the user's programs                                      | Yes                                                                     | The spec trusts code the user already runs as themselves                |
| A program the user runs with fewer rights (a sandbox, another user, a chroot) that kept the token | Not as another user (refused by uid); a sandboxed same-user process can | The program that starts it should drop `OSC7577_TOKEN` (spec, Security) |

Refused outright:

- A command whose report did not pass the mac and time checks is never kept and never run.
- A record is never run for another user: a uid that differs from the host's at resume time discards it.
- The host never accepts or resumes anything when it runs as root, or on Windows, which this implementation does not
  cover yet.
- A record whose reported `cwd` no longer exists is not resumed.
- At most 256 records per host. A report past that is rejected.

The resumed command and its terminal are written to the host log, escaped (control characters and direction overrides
shown as `\uXXXX`).

## Turning it off

`doriface-host --no-resume` gives terminals no token and resumes nothing (the `resume: false` host option).

## Limits of this implementation

- Reports are read from the moment the host watches a terminal. A report written before that (in the first moments
  of a terminal's life, or while the host was not running) is missed, and the program has to report again.
- A resumed terminal gets a new address. Its tab comes back as the core lists it, not in the old pane's place.
- Shells it can type into: `sh`, `bash`, `zsh`, `dash`, `ksh`, `mksh`, `ash`, `yash`, `loksh` and `fish`. For any
  other shell the command starts as the terminal's first process instead.
