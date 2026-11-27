import { join } from "node:path";

/**
 * A named host beside the default one (#2858): its own state dir (keys, hostId, mesh, pairings, lock, sockets), its own
 * hc session (a separate core, so terminals and machines stay per mesh) and any free loopback port. One device joins one
 * mesh per profile. Profiles run as the same OS user, so they separate meshes for convenience, not for security.
 */
export const PROFILE_ENV = "DORITERM_PROFILE";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export class ProfileRefused extends Error {
  override readonly name = "ProfileRefused";
}

/** The profile `$DORITERM_PROFILE` names, undefined when unset or empty; a malformed name is refused, never cleaned. */
export function hostProfile(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const name = env[PROFILE_ENV];
  if (name === undefined || name === "") return undefined;
  if (!NAME.test(name)) {
    throw new ProfileRefused(
      `${PROFILE_ENV}=${JSON.stringify(name)}: a profile is 1-32 lowercase letters, digits and inner dashes`,
    );
  }
  return name;
}

export const profileStateDir = (stateRoot: string, profile: string): string =>
  join(stateRoot, "doriface-host-profiles", profile);

/** The hc session a profile's host serves: its own core, which `hc --session doriterm-<name>` reaches. */
export const profileSession = (profile: string): string => `doriterm-${profile}`;

const DEFAULT_LISTEN = "127.0.0.1:7766";
/** Any free loopback port, as the desktop app's own host takes: the default host keeps 7766. */
const PROFILE_LISTEN = "127.0.0.1:0";

/** What `serve` runs with: a flag given wins, else the profile's own listener and session, else the default host's. */
export function serveDefaults(
  profile: string | undefined,
  given: { readonly listen?: string | undefined; readonly session?: string | undefined },
): { readonly listen: string; readonly session: string | undefined } {
  return {
    listen: given.listen ?? (profile === undefined ? DEFAULT_LISTEN : PROFILE_LISTEN),
    session: given.session ?? (profile === undefined ? undefined : profileSession(profile)),
  };
}

/** The setup skill's options for a profile's service: its own label, state dir, session and listener. */
export function profileSetupOptions(
  profile: string,
  os: "linux" | "mac",
  stateRoot: string,
): { readonly label: string; readonly stateDir: string; readonly session: string; readonly listen: string } {
  return {
    label: os === "mac" ? `com.sisyphuslabs.doriface-host.${profile}` : `doriface-host-${profile}`,
    stateDir: profileStateDir(stateRoot, profile),
    session: profileSession(profile),
    listen: PROFILE_LISTEN,
  };
}
