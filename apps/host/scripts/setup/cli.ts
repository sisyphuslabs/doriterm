#!/usr/bin/env bun
/** The setup skill's command line (skills/doriterm-setup/SKILL.md); every step lives in setup.ts. */
import { parseArgs } from "node:util";
import { SetupError } from "./render.ts";
import {
  checkBun,
  ensureHc,
  ensureService,
  findHc,
  invite,
  joinMesh,
  resolvePaths,
  setupContext,
  uninstall,
  updateCheckout,
  verify,
  waitForRelay,
  type Report,
} from "./setup.ts";

const USAGE = `usage: bun apps/host/scripts/setup/cli.ts <command> [options]

  install            install or update the host as a user service and wait for the relay (safe to re-run)
  verify             service running, relay connected, mesh members (--min-members N fails below N)
  invite --out <f>   write a single-use mesh join link (10 minutes) for another machine to <f>, mode 0600
  join --from <f>    join the mesh of the machine that wrote <f>, then delete <f>
  pair               print the pairing QR code, link and code for a phone or browser (for the user's own screen)
  uninstall          stop and remove the service; keys, paired devices, mesh and checkout stay

  --ref <branch>     the branch to install or update to (default dev)
  --src <dir>        the checkout (default ~/.local/share/doriface-host/src)
  --state-dir <dir>  the host's state (default: the installed service's, else ~/.local/state/doriface-host-mesh)
  --label <name>     the LaunchAgent label or systemd unit name (default com.sisyphuslabs.doriface-host / doriface-host)
  --listen <h:p>     the host's loopback listener (default 127.0.0.1:7766)
  --session <name>   the hc session (a separate core) the host serves (default: hc's default core)
  --timeout <s>      how long install waits for the relay (default 90)`;

const report: Report = (step, status, detail) => {
  process.stdout.write(`doriterm-setup: ${step} ${status} ${detail}\n`);
};

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: true,
    options: {
      ref: { type: "string", default: "dev" },
      src: { type: "string" },
      "state-dir": { type: "string" },
      label: { type: "string" },
      listen: { type: "string" },
      session: { type: "string" },
      timeout: { type: "string", default: "90" },
      out: { type: "string" },
      from: { type: "string" },
      "min-members": { type: "string", default: "0" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command] = positionals;
  if (values.help || command === undefined || positionals.length !== 1) {
    process.stdout.write(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }
  const context = setupContext(report, {
    src: values.src,
    stateDir: values["state-dir"],
    label: values.label,
    listen: values.listen,
    session: values.session,
  });
  switch (command) {
    case "install": {
      checkBun(context);
      const checkout = await updateCheckout(context, values.ref);
      if (checkout.changed && process.env["DORITERM_SETUP_REEXEC"] !== checkout.sha) {
        // The checkout moved under this process: finish with the setup code it moved to.
        const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
          env: { ...process.env, DORITERM_SETUP_REEXEC: checkout.sha },
          stdio: ["inherit", "inherit", "inherit"],
        });
        // The child reports its own result line.
        process.exit(await child.exited);
      }
      const paths = resolvePaths(context, await ensureHc(context));
      const service = await ensureService(context, paths, process.env["DORITERM_SETUP_REEXEC"] !== undefined);
      if (service.restarted) await waitForRelay(context, paths, service.logFrom, Number(values.timeout) * 1000);
      await verify(context, paths);
      return 0;
    }
    case "verify":
      await verify(context, resolvePaths(context, await ensureHcQuiet(context)), Number(values["min-members"]));
      return 0;
    case "invite":
      if (values.out === undefined) throw new SetupError("invite", "invite needs --out <file>");
      await invite(context, resolvePaths(context, await ensureHcQuiet(context)), values.out);
      return 0;
    case "join":
      if (values.from === undefined) throw new SetupError("join", "join needs --from <file>");
      await joinMesh(context, resolvePaths(context, await ensureHcQuiet(context)), values.from);
      return 0;
    case "pair": {
      const paths = resolvePaths(context, await ensureHcQuiet(context));
      const child = Bun.spawn([paths.bun, `${paths.src}/apps/host/src/cli.ts`, "pair", "--state-dir", paths.stateDir], {
        stdio: ["inherit", "inherit", "inherit"],
      });
      return child.exited;
    }
    case "uninstall":
      await uninstall(context, resolvePaths(context, await ensureHcQuiet(context)));
      return 0;
    default:
      process.stdout.write(`${USAGE}\n`);
      return 2;
  }
}

async function ensureHcQuiet(context: ReturnType<typeof setupContext>): Promise<string> {
  return findHc(context);
}

main(Bun.argv.slice(2)).then(
  (code) => {
    report("result", code === 0 ? "ok" : "fail", `exit ${code}`);
    process.exit(code);
  },
  (error: unknown) => {
    const step = error instanceof SetupError ? error.code : "error";
    report(step, "fail", error instanceof Error ? error.message : String(error));
    report("result", "fail", "exit 1");
    process.exit(1);
  },
);
