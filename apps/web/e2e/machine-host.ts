// A doriface-host beside the second core, as a mesh member runs one beside its own: it writes that machine's facts
// (the agent skill status) on that core and answers what clients ask there, with its own HOME so no real agent skill
// directory is touched.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { E2E_TOKEN } from "./config.ts";

const LISTENING_WITHIN_MS = 30_000;

/** Reads the host's stderr through to this process's, and resolves with the URL its start-up line names. */
async function listeningUrl(stderr: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stderr.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const timeout = AbortSignal.timeout(LISTENING_WITHIN_MS);
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the start-up line arrives in chunks
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        timeout.addEventListener("abort", () => reject(new Error("the machine's host did not start in time"))),
      ),
    ]);
    if (next.done) throw new Error(`the machine's host exited before it listened: ${text}`);
    process.stderr.write(next.value);
    text += decoder.decode(next.value, { stream: true });
    const url = /listening on (ws:\/\/\S+)/.exec(text)?.[1];
    if (url !== undefined) {
      void (async () => {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- passes the rest of its log through
          const more = await reader.read();
          if (more.done) return;
          process.stderr.write(more.value);
        }
      })();
      return url;
    }
  }
}

/**
 * Starts the host on the second core's session and opens one pipe, which starts its writers; resolves with its stop.
 * The pipe stands in for the connection the app keeps to each mesh member: a host starts its writers once its core is up
 * (a pipe, or a mesh), and joining two hosts into a mesh needs the private relay, which this suite runs without.
 */
export async function startMachineHost(
  hc: string,
  env: Record<string, string | undefined>,
  session: string,
  root: string,
): Promise<() => Promise<void>> {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const cli = join(import.meta.dir, "../../host/src/cli.ts");
  const host = Bun.spawn(
    ["bun", cli, "--listen", "127.0.0.1:0", "--hc", hc, "--session", session, "--token", E2E_TOKEN, "--no-relay"],
    { env: { ...env, HOME: home }, stdout: "ignore", stderr: "pipe" },
  );
  const stop = async (): Promise<void> => {
    host.kill("SIGTERM");
    await host.exited;
  };
  try {
    const url = await listeningUrl(host.stderr);
    const pipe = new WebSocket(url, ["doriface.v1", `doriface.token.${E2E_TOKEN}`]);
    await new Promise<void>((resolve, reject) => {
      pipe.addEventListener("open", () => resolve(), { once: true });
      pipe.addEventListener("error", () => reject(new Error("the machine's host refused a pipe")), { once: true });
    });
    return async () => {
      pipe.close();
      await stop();
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
