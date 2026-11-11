// The command the desktop app's LocalHost spawns in test/local-host.test.ts: prints the arguments it was given and the
// folder it was started in, then the ready line LocalHost waits for, and stays up until LocalHost stops it.
process.stderr.write(`SPAWN-ARGS ${JSON.stringify(process.argv.slice(2))}\n`);
process.stderr.write(`SPAWN-CWD ${process.cwd()}\n`);
process.stderr.write("listening on ws://127.0.0.1:1/v1/hc\n");
setInterval(() => {}, 1 << 30);
