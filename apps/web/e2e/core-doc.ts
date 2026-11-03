// A spec's write to a herdr document on the e2e host's own core, the way another client would make it: read the
// version, then a compare-and-set at it, with the core environment the e2e host saved (E2E_HOST_ENV).
import { execFileSync } from "node:child_process";
import { E2E_HOST_ENV } from "./config.ts";
import { readSavedEnv, type SavedEnv } from "./saved-env.ts";

interface CoreEnv extends SavedEnv {
  readonly session: string;
}

function coreEnv(): CoreEnv {
  const saved = readSavedEnv(E2E_HOST_ENV);
  const session = saved.env["HC_SESSION"];
  if (session === undefined) throw new Error(`${E2E_HOST_ENV} names no HC_SESSION`);
  return { ...saved, session };
}

function call(core: CoreEnv, method: string, params: unknown): unknown {
  const request = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`;
  const reply = execFileSync(core.hc, ["connect", "--session", core.session], {
    env: { ...process.env, ...core.env },
    input: request,
  }).toString();
  for (const line of reply.split("\n")) {
    const message: unknown = line.trim() === "" ? undefined : JSON.parse(line);
    if (typeof message === "object" && message !== null && "id" in message && message.id === 1) {
      if ("result" in message) return message.result;
      throw new Error(`${method} failed: ${line.slice(0, 300)}`);
    }
  }
  throw new Error(`${method}: no reply`);
}

export function setCoreDoc(name: string, value: unknown): void {
  const core = coreEnv();
  const current = call(core, "doc.get", { name });
  const version = typeof current === "object" && current !== null && "version" in current ? current.version : 0;
  call(core, "doc.set", { name, value, version });
}
