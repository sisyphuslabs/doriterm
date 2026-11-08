/**
 * The desktop shell's byte forwarder, standing in for the preload bridge a shell window exposes (#449).
 *
 * It answers each `forwardDirect` with the target the page froze, so the direct race runs against a real listener; and
 * `targets` records every target it was asked to forward to, which is how a test sees whether a direct dial was
 * attempted at all. It is the one thing that marks a page as the desktop shell for `openDirect` (#1381 §8).
 */
export interface ShellForwarder {
  /** Every target the page asked the shell to forward to, in order. */
  readonly targets: readonly string[];
  /** Puts the page back the way it was, so another test in the file is a browser again. */
  readonly restore: () => void;
}

export function installShellForwarder(scope: object = globalThis): ShellForwarder {
  const previous: unknown = Reflect.get(scope, "doriface");
  const targets: string[] = [];
  let target = "";
  Reflect.set(scope, "doriface", {
    setDirectTarget: (url: unknown): boolean => {
      target = typeof url === "string" ? url : "";
      targets.push(target);
      return true;
    },
    forwardDirect: (): { readonly url: string } => ({ url: target }),
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
