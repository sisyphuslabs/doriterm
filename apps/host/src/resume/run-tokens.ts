/**
 * The OSC 7577 token of each terminal a client starts on this core: added to the env of its `terminal.run`, so the
 * terminal's first process gets it and nothing else does. A run on another machine (`on`) gets none: a remote host must
 * never register a command that runs here.
 */
import { field, rpcOf } from "../rpc-lines.ts";

export const TOKEN_VAR = "OSC7577_TOKEN";
/** The terminal identity a client passes in a run's env, which a relaunch passes again; no other env is kept. */
const IDENTITY = ["TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "COLORTERM"];

export interface RunStarted {
  readonly address: string;
  readonly token: string;
  readonly name: string | null;
  readonly env: Readonly<Record<string, string>>;
}

export interface RunTokens {
  /** The payload of a `terminal.run` request with a fresh token in its env; undefined sends the request as it is. */
  rewrite(payload: Uint8Array): Uint8Array | undefined;
  /** A reply from the core: the answer to a rewritten run starts tracking its terminal. */
  answered(payload: Uint8Array): void;
  /** Whether any rewritten run is still unanswered. */
  readonly waiting: boolean;
}

/** 24 random bytes as base64url: 32 characters of the spec's alphabet, 192 bits. */
export const mintToken = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function runTokens(started: (run: RunStarted) => void, mint: () => string = mintToken): RunTokens {
  const pending = new Map<string, Omit<RunStarted, "address">>();
  return {
    rewrite(payload) {
      const request = rpcOf(payload);
      if (request?.method !== "terminal.run" || request.id === undefined || request.id === null) return undefined;
      const params = request.params ?? {};
      if (!isObject(params)) return undefined;
      const on = field(params, "on");
      if (typeof on === "string" && on !== "") return undefined;
      const env = params["env"] ?? {};
      if (!isObject(env)) return undefined;
      const token = mint();
      const name = params["name"];
      const identity = Object.fromEntries(
        IDENTITY.flatMap((key) => (typeof env[key] === "string" ? [[key, env[key]]] : [])),
      );
      pending.set(JSON.stringify(request.id), {
        token,
        name: typeof name === "string" && name !== "" ? name : null,
        env: identity,
      });
      const rewritten = { ...request, params: { ...params, env: { ...env, [TOKEN_VAR]: token } } };
      return new TextEncoder().encode(JSON.stringify(rewritten));
    },
    answered(payload) {
      if (pending.size === 0) return;
      const reply = rpcOf(payload);
      if (reply === undefined || reply.method !== undefined || reply.id === undefined) return;
      const key = JSON.stringify(reply.id);
      const run = pending.get(key);
      if (run === undefined) return;
      pending.delete(key);
      const address = field(reply.result, "address");
      if (typeof address === "string" && address !== "") started({ ...run, address });
    },
    get waiting() {
      return pending.size > 0;
    },
  };
}
