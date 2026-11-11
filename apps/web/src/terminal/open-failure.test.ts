import { HcRpcError } from "@doriface/protocol";
import { expect, test } from "bun:test";
import { openFailure } from "./open-failure.ts";

const rpc = (kind: string, message = kind): HcRpcError => new HcRpcError({ code: -32000, message, data: { kind } });
const UNREACHABLE = "build can't be reached right now, so this terminal can't open.";
const FAILED = "The connection to this terminal failed before it opened.";

test.each([
  ["hc's unavailable kind, on an added machine", "build/t3", rpc("unavailable"), UNREACHABLE],
  [
    "an unreachable message under another kind",
    "build/t3",
    rpc("internal", "machine build is unreachable"),
    UNREACHABLE,
  ],
  ["the same kind on this machine, which has no name to give", "t3", rpc("unavailable"), FAILED],
  ["any other hc error", "build/t3", rpc("unknown"), FAILED],
  ["a failure that is not hc's", "build/t3", new Error("socket closed"), FAILED],
  ["no cause at all", "build/t3", undefined, FAILED],
] as const)("%s", (_name, address, cause, words) => {
  expect(openFailure(address, cause)).toBe(words);
});
