/**
 * The strings a capture must never show, one per leak shape: the half of the proof that says the check catches rather
 * than merely spares. capture-text.test.ts runs every one, so a pattern widened until it matches nothing turns red.
 */
export const KNOWN_BAD: readonly { readonly text: string; readonly why: string }[] = [
  { text: "alpha-center@build-box ~ % ls", why: "zsh prompt, no colon" },
  { text: "User@Users-MacBook-Pro ~ % ls", why: "capitalised account and host" },
  { text: "Alice@build-box:~$ ls", why: "capitalised account" },
  { text: "alpha@build.acme.dev:~$ ls", why: "fully qualified host" },
  { text: "someone@localhost:~$ ls", why: "named account on a neutral host" },
  { text: "someone@my-laptop:~$ ls", why: "named account on a neutral host, my- prefix" },
  { text: "alpha@a-host:/srv/run/clone$ ls", why: "account at host with a path" },
  { text: "/Users/someone/project", why: "home directory" },
  { text: "/home/someone/project", why: "home directory, Linux" },
  { text: "/srv/runs/x/clone", why: "run root" },
  { text: "/var/folders/xy/abc/T/x", why: "run root, macOS temp" },
  { text: "/private/tmp/x/clone", why: "run root, macOS private temp" },
  { text: "/tmp/x/clone", why: "run root, temp" },
  { text: "/opt/omo-runs/x", why: "system install root" },
  { text: "ssh someone@a-host", why: "ssh target" },
  { text: "someone@github.com", why: "named account at a registry host" },
  { text: "someone@notexample.com", why: "a host that merely ends in example.com's name" },
  { text: "support@doriterm.com", why: "account at a real domain" },
];

/** What a mockup is meant to show: a reserved example domain names no one, and neither does a clone URL's git user. */
export const PLACEHOLDERS: readonly { readonly text: string; readonly why: string }[] = [
  { text: "you@example.com", why: "placeholder email at example.com" },
  { text: "support@example.org", why: "placeholder email at example.org" },
  { text: "billing@example.net", why: "placeholder email at example.net" },
  { text: "alice@studio.example", why: "placeholder email under the .example name" },
  { text: "someone@example", why: "placeholder email at bare example" },
  { text: "you@mail.example.com", why: "placeholder email at a subdomain of example.com" },
  { text: "ops@eu.mail.example.org", why: "placeholder email at a subdomain of example.org" },
  { text: "git@gitlab.example.com:owner/repo.git", why: "a clone URL at a subdomain of example.com" },
  { text: "git clone git@github.com:owner/repo.git", why: "a clone URL's git user" },
];
