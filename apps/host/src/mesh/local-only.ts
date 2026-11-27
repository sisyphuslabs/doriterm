/** What a local-only host (`doriface-host --local-only`) answers any offer or join: it keeps no relay to reach it by. */
export class LocalOnlyError extends Error {
  override readonly name = "LocalOnlyError";

  constructor() {
    super(
      "this host runs local-only (--local-only): it keeps no relay, so no device or machine outside this computer can pair with it or join a mesh through it",
    );
  }
}
