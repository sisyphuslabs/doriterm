import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fitReply, hcCli } from "./hc-cli.ts";
import { MAX_MCP_LINE, toolResult } from "./lines.ts";

const fakeHc = (script: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "dh-hc-cli-")), "hc");
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
};
const lineBytes = (value: unknown): number =>
  Buffer.byteLength(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: toolResult(value, false) })}\n`);

test("any output, escapes and non-ASCII included, is cut to fit one MCP reply line and says so", async () => {
  const run = hcCli({ hc: fakeHc(`awk 'BEGIN { for (i = 0; i < 40000; i++) printf "\\033[31m한글 line %d\\n", i }'`) });
  const result = fitReply(await run(["read", "t1"], { timeoutMs: 30_000, signal: new AbortController().signal }));
  expect(lineBytes(result)).toBeLessThanOrEqual(MAX_MCP_LINE);
  expect(result.truncated).toBe(true);
  expect(result.stdout.length).toBeGreaterThan(1000);
});

test("a command that ignores SIGTERM still ends at its deadline", async () => {
  const run = hcCli({ hc: fakeHc(`trap '' TERM; sleep 30`) });
  const started = Date.now();
  const result = await run(["wait", "t1"], { timeoutMs: 300, signal: new AbortController().signal });
  expect(result.timedOut).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
});
