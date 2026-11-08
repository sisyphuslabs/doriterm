const STATES = ["idle", "working", "done", "blocked", "error"] as const;

export type ProgramStatus = {
  readonly state: (typeof STATES)[number];
  readonly progress: number | null;
  readonly app: string;
};

type Invoke = (name: string, ...args: readonly number[]) => unknown;
type Call = (name: string, ...args: readonly number[]) => number;

function invoker(exports: WebAssembly.Exports): Invoke {
  return (name, ...args) => {
    const fn = exports[name];
    if (typeof fn !== "function") throw new Error(`ghostty-vt.wasm has no export ${name}`);
    const result: unknown = fn(...args);
    return result;
  };
}

function numeric(invoke: Invoke): Call {
  return (name, ...args) => {
    const result = invoke(name, ...args);
    if (typeof result !== "number") throw new Error(`${name} returned ${typeof result}`);
    return result;
  };
}

/** GhosttyCore 0.5.9 has no getter for OSC 7501, so this drives the raw exports. */
export async function readRootProgramStatus(wasm: Uint8Array, input: string): Promise<ProgramStatus | null> {
  const { instance } = await WebAssembly.instantiate(wasm, { env: { log: () => undefined } });
  const { exports } = instance;
  const memory = exports["memory"];
  if (!(memory instanceof WebAssembly.Memory) || typeof exports["get_program_status_state"] !== "function") return null;
  const invoke = invoker(exports);
  const call = numeric(invoke);
  const term = call("init", 80, 24, 10_000, 0xffffff, 0, 0);
  try {
    const bytes = new TextEncoder().encode(input);
    const buffer = call("alloc_buffer", bytes.byteLength);
    new Uint8Array(memory.buffer, buffer, bytes.byteLength).set(bytes);
    invoke("write", term, buffer, bytes.byteLength);
    invoke("free_buffer", buffer, bytes.byteLength);
    const state = STATES[call("get_program_status_state", term)];
    if (state === undefined) return null;
    const progress = call("get_program_status_progress", term);
    const appBytes = new Uint8Array(
      memory.buffer,
      call("get_program_status_app_ptr", term),
      call("get_program_status_app_len", term),
    );
    return { state, progress: progress < 0 ? null : progress, app: new TextDecoder().decode(appBytes) };
  } finally {
    invoke("deinit", term);
  }
}
