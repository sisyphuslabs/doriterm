# Running several agents with hc

Read this when you start more than one agent, or one whose work outlives your turn. The commands are in `hc.md`; this file is the discipline that keeps parallel work from colliding or getting lost.

## Keep a ledger of what you started

hc tells you what runs now; your ledger tells you what is yours. Keep it in a file in your working directory and update it from each launch result: address (`machine/t7`), name, purpose, the task it holds, what it may write, where its result goes.

- Record a launch even when the agent fails to start, so it still gets cleaned up.
- Register only what you created or were handed by name. An idle agent in the same folder is not yours.
- An address proves a location, not an occupant. Before sending input, reassigning or closing, run `hc get <t>` and confirm the same program is still there.
- After a restart or a lost context, load the old ledger and check each entry against hc. Never start a fresh ledger over unfinished work.

## Subscribe first, then read

1. Start `hc events --children-of $HC_TERMINAL_ID` (or `--label k=v` for a labelled set) and keep it running where its lines wake you.
2. Then read the snapshot (`hc ls`, `hc get <t>`) and reconcile the ledger with it.
3. Treat an event as "this entry is stale, read it again". Events and snapshots share no sequence, so replaying event payloads over a snapshot drifts.
4. If the stream ends, mark every cached state stale, pause input and cleanup that depend on it, resubscribe, then read again.

## Split by dependency, one writer per shared thing

Before launching, list what each unit reads, writes and waits on. Units that share no written state start together; order only the edges that exist.

- One writer at a time for each file, branch, pull request, port, cache, database and generated artifact. Separate worktrees do not remove a conflict over a shared branch, port or pull request.
- If two units turn out to overlap, pause the affected edits, keep what exists, and decide who owns it before anyone continues.
- Give independent files or research another terminal in the same checkout; give work that needs its own branch or build a new worktree.

## What every assignment carries

Put the first task in `hc run`, and write a long brief to a file and pass its absolute path.

1. How to report back: `hc send <your address> "<result>"`, and a result file path unique to this task.
2. The objective, the context it needs, and its dependencies.
3. The working directory and the exact files or resources it may change.
4. Constraints, deliverables, acceptance criteria and the commands that verify them.
5. Whether it may start agents of its own (default: no), and that it reports blockers and scope questions at once.

Name the terminal (`--name`) and label it (`hc label <t> task=T-01`) so a person can follow it in the Doriterm app.

## Sending and waiting

- Send a new task only to a session that is ready for input. `hc send --wait` joins the send and the wait without a race.
- A returned wait says the status changed, not that the task was accepted or done well. A timeout or dropped connection does not prove the message never arrived: read the terminal and the result file before resending.
- `blocked` means a person is needed. Answer only what your own task already covers; take the rest to your user.
- If the program in a terminal exited or was replaced, the old assignment is over. A new agent in the same terminal inherits nothing.

## Verify, then clean up

`idle` and `done` mean "check the result now". Read the result file for this exact task (`hc read` when there is none), compare the changes with the allowed scope and the acceptance criteria, integrate, then verify the combined result. Keep failed, pending and uncertain apart in your report.

Clean up in this order:

1. Save results and evidence somewhere that outlives the worktree.
2. Re-check that each terminal is yours, still holds the same task, and has nothing running.
3. `hc kill <t>; hc rm <t>`. Leave anything with unsaved changes or that the user will keep using, and say where it is.
4. Remove worktrees without force once their changes are merged or saved.
5. Read back that each one is gone, update the ledger, then stop your event stream.
