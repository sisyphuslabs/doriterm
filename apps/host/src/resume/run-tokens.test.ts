import { describe, expect, test } from "bun:test";
import { mintToken, type RunStarted, runTokens, TOKEN_VAR } from "./run-tokens.ts";

const encoder = new TextEncoder();
const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const parsed = (bytes: Uint8Array | undefined): unknown => JSON.parse(new TextDecoder().decode(bytes));

/** A hook whose tokens are numbered, and every run it saw start. */
function hook() {
  const started: RunStarted[] = [];
  let minted = 0;
  const tokens = runTokens(
    (run) => started.push(run),
    () => `token-${(minted += 1)}-padding-to-22`,
  );
  return { tokens, started };
}

describe("runTokens", () => {
  test("a run on this core gets a fresh token in its env, beside the client's terminal identity", () => {
    const { tokens } = hook();
    const env = { TERM: "xterm-256color", COLORTERM: "truecolor" };
    const out = tokens.rewrite(
      json({ jsonrpc: "2.0", id: 4, method: "terminal.run", params: { name: "opened-1", env } }),
    );
    expect(parsed(out)).toEqual({
      jsonrpc: "2.0",
      id: 4,
      method: "terminal.run",
      params: { name: "opened-1", env: { ...env, [TOKEN_VAR]: "token-1-padding-to-22" } },
    });
  });

  test("a run with no params (the machine's shell) gets one too, and each run gets its own", () => {
    const { tokens } = hook();
    const first = parsed(tokens.rewrite(json({ id: 1, method: "terminal.run" })));
    const second = parsed(tokens.rewrite(json({ id: 2, method: "terminal.run", params: {} })));
    expect(first).toMatchObject({ params: { env: { [TOKEN_VAR]: "token-1-padding-to-22" } } });
    expect(second).toMatchObject({ params: { env: { [TOKEN_VAR]: "token-2-padding-to-22" } } });
  });

  test("a token a client put in the env is replaced, never passed on", () => {
    const { tokens } = hook();
    const out = tokens.rewrite(json({ id: 1, method: "terminal.run", params: { env: { [TOKEN_VAR]: "mine" } } }));
    expect(parsed(out)).toMatchObject({ params: { env: { [TOKEN_VAR]: "token-1-padding-to-22" } } });
  });

  test("a run on another machine, another method, a notification or a malformed env is left as it is", () => {
    const { tokens } = hook();
    expect(tokens.rewrite(json({ id: 1, method: "terminal.run", params: { on: "box" } }))).toBeUndefined();
    expect(tokens.rewrite(json({ id: 1, method: "terminal.send", params: {} }))).toBeUndefined();
    expect(tokens.rewrite(json({ method: "terminal.run", params: {} }))).toBeUndefined();
    expect(tokens.rewrite(json({ id: 1, method: "terminal.run", params: { env: ["A=1"] } }))).toBeUndefined();
    expect(tokens.rewrite(encoder.encode("not json"))).toBeUndefined();
    expect(tokens.waiting).toBe(false);
  });

  test("the answer to a rewritten run starts tracking its terminal with the run's name and identity only", () => {
    const { tokens, started } = hook();
    const env = { TERM: "xterm-256color", SECRET: "x" };
    tokens.rewrite(json({ id: "a", method: "terminal.run", params: { name: "opened-1", env } }));
    expect(tokens.waiting).toBe(true);
    tokens.answered(json({ id: "b", result: { address: "t9" } }));
    tokens.answered(json({ id: "a", result: { address: "t3" } }));
    expect(started).toEqual([
      { address: "t3", token: "token-1-padding-to-22", name: "opened-1", env: { TERM: "xterm-256color" } },
    ]);
    expect(tokens.waiting).toBe(false);
  });

  test("a refused run tracks nothing", () => {
    const { tokens, started } = hook();
    tokens.rewrite(json({ id: 7, method: "terminal.run", params: {} }));
    tokens.answered(json({ id: 7, error: { code: -32000, message: "no" } }));
    expect(started).toEqual([]);
    expect(tokens.waiting).toBe(false);
  });
});

test("mintToken gives 32 characters of the spec's alphabet, never the same twice", () => {
  const tokens = new Set(Array.from({ length: 64 }, () => mintToken()));
  expect(tokens.size).toBe(64);
  for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
});
