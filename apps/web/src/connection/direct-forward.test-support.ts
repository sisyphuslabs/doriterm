/**
 * The desktop shell's byte forwarder, standing in for the preload bridge a shell window exposes (#449).
 *
 * It answers each `forwardDirect` with the target the request named, so the direct race runs against a real listener;
 * and `targets` records every target it was asked to forward to, which is how a test sees whether a direct dial was
 * attempted at all. It is the one thing that marks a page as the desktop shell for `openDirect` (#1381 §8).
 */
export interface ShellForwarder {
  /** Every target the page named in a forward request, in order. */
  readonly targets: readonly string[];
  /** Puts the page back the way it was, so another test in the file is a browser again. */
  readonly restore: () => void;
}

export function installShellForwarder(scope: object = globalThis): ShellForwarder {
  const previous: unknown = Reflect.get(scope, "doriface");
  const targets: string[] = [];
  Reflect.set(scope, "doriface", {
    forwardDirect: (target: unknown): { readonly url: string } => {
      const url = typeof target === "string" ? target : "";
      targets.push(url);
      return { url };
    },
    cancelDirectForward: (): boolean => true,
  });
  return {
    targets,
    restore: () => {
      if (previous === undefined) Reflect.deleteProperty(scope, "doriface");
      else Reflect.set(scope, "doriface", previous);
    },
  };
}
