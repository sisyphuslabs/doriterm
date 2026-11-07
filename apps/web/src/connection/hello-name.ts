import type { HcConnection } from "@doriface/client";

/**
 * The name a host gave itself in its hello, or `""` when it gave none: Settings names a host by this while it answers, and a
 * session must never fail over a name it could not read (#496).
 */
export function helloName(connection: HcConnection): string {
  const hello: { readonly core?: { readonly name?: string } } | undefined = connection.hello;
  return hello?.core?.name ?? "";
}
