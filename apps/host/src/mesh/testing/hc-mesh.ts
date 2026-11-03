import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHcSession, type HcSession } from "../../testing/hc-session.ts";
import { type HcControl, type HcMachines, openHcControl, spawnHcLink } from "../hc-machines.ts";
import { type LineSocket, listenLineSocket } from "../line-socket.ts";
import type { MeshLines } from "../mesh-lines.ts";
import type { MeshMember } from "../upstream.ts";
import { shellQuote } from "../via.ts";

const CLI = join(import.meta.dir, "..", "..", "cli.ts");

/** A scratch herdr core with a control connection, and the mesh member card that names it. */
export interface Core {
  readonly session: HcSession;
  readonly control: HcControl;
  readonly member: MeshMember;
  dispose(): Promise<void>;
}

/** A hostId the relay client accepts (`[a-z2-7]{25}[aeimquy4]`), derived from a short name. */
export const hostIdFor = (name: string): string => `${name.replaceAll(/[^a-z2-7]/g, "")}host`.padEnd(25, "z") + "a";

export async function startCore(name: string): Promise<Core> {
  const session = createHcSession(`mesh-${name}`);
  const control = await openHcControl({ hc: session.hc, session: session.name, env: session.env });
  const member: MeshMember = {
    signPub: `sign-${name}`,
    hostId: hostIdFor(name),
    noisePub: `noise-${name}`,
    name,
    hcId: control.coreId,
  };
  return {
    session,
    control,
    member,
    dispose: async () => {
      control.close();
      await session.dispose();
    },
  };
}

/** A command that reaches `core` directly (a pre-mesh machine entry); the `#` drops the shell line herdr appends. */
export function directVia(core: Core): string {
  const { env, hc, name } = core.session;
  const vars = ["HC_SOCKET", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"].map((key) => `${key}=${shellQuote(env[key] ?? "")}`);
  return `${vars.join(" ")} ${shellQuote(hc)} connect --session ${name} #`;
}

export interface LocalHost {
  /** The doriface-host program the vias name: a wrapper whose path holds a space and a `'`. */
  readonly program: string;
  /** This host's state dir (where line.sock lives), also with a space and a `'` in its path. */
  readonly stateDir: string;
  serve(lines: MeshLines): LineSocket;
  dispose(): void;
}

export function localHost(): LocalHost {
  const root = mkdtempSync(join(tmpdir(), "m-"));
  const bin = join(root, "it's bin");
  const stateDir = join(root, "st 'a");
  mkdirSync(bin, { recursive: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const program = join(bin, "doriface-host");
  writeFileSync(program, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(CLI)} "$@"\n`);
  chmodSync(program, 0o755);
  let sockets: LineSocket[] = [];
  return {
    program,
    stateDir,
    serve(lines) {
      const socket = listenLineSocket({
        path: join(stateDir, "line.sock"),
        grant: (id) => lines.grant(id),
        log: () => undefined,
      });
      sockets.push(socket);
      return socket;
    },
    dispose() {
      for (const socket of sockets) socket.stop();
      sockets = [];
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Stands in for the relay and Noise hop: a granted line to a member is piped to that member's real core. */
export const dialCore = (cores: readonly Core[]) => (member: MeshMember) => {
  const core = cores.find((candidate) => candidate.member.hostId === member.hostId);
  if (core === undefined) return Promise.reject(new Error(`no core for ${member.name}`));
  return Promise.resolve(spawnHcLink({ hc: core.session.hc, session: core.session.name, env: core.session.env }));
};

export interface Recorded extends HcMachines {
  readonly calls: string[];
  readonly maxConcurrentAdds: () => number;
}

/** Wraps the real calls, recording each one and the most adds in flight at once. */
export function recorded(machines: HcMachines): Recorded {
  const calls: string[] = [];
  let inFlight = 0;
  let most = 0;
  return {
    calls,
    maxConcurrentAdds: () => most,
    list: () => machines.list(),
    connect: (name) => machines.connect(name),
    add: async (name, via) => {
      calls.push(`add ${name}`);
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        return await machines.add(name, via);
      } finally {
        inFlight -= 1;
      }
    },
    rm: (name) => {
      calls.push(`rm ${name}`);
      return machines.rm(name);
    },
    rename: (name, newName) => {
      calls.push(`rename ${name} ${newName}`);
      return machines.rename(name, newName);
    },
  };
}
