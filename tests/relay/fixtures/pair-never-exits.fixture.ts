import { writeFileSync } from "node:fs";

// Not a *.test.ts: a pair CLI that never exits, for relayed-host.test.ts (#2155). It says it runs by writing PAIR_MARK,
// then holds its step until it is killed.
writeFileSync(process.env["PAIR_MARK"] ?? "", "held");
setInterval(() => {}, 1 << 30);
