import { classify } from "./capture-text.ts";

const KNOWN_BAD: readonly { readonly text: string; readonly why: string }[] = [
  { text: "alpha-center@build-box ~ % ls", why: "zsh prompt, no colon" },
  { text: "User@Users-MacBook-Pro ~ % ls", why: "capitalised account and host" },
  { text: "Alice@build-box:~$ ls", why: "capitalised account" },
  { text: "alpha@build.example.com:~$ ls", why: "fully qualified host" },
  { text: "someone@localhost:~$ ls", why: "named account on a neutral host" },
  { text: "someone@my-laptop:~$ ls", why: "named account on a neutral host" },
  { text: "alpha@a-host:/srv/run/clone$ ls", why: "account at host with a path" },
  { text: "/Users/someone/project", why: "home directory" },
  { text: "/home/someone/project", why: "home directory, Linux" },
  { text: "/srv/runs/x/clone", why: "run root" },
  { text: "/var/folders/xy/abc/T/x", why: "run root, macOS temp" },
  { text: "/private/tmp/x/clone", why: "run root, macOS private temp" },
  { text: "/tmp/x/clone", why: "run root, temp" },
  { text: "/opt/omo-runs/x", why: "system install root" },
  { text: "ssh someone@a-host", why: "ssh target" },
];

let flagged = 0;
const missed: string[] = [];
for (const { text, why } of KNOWN_BAD) {
  const verdict = classify(text);
  if (verdict.ok) missed.push(why);
  else flagged += 1;
}

console.log(`known-bad strings: ${flagged}/${KNOWN_BAD.length} flagged`);
if (missed.length > 0) {
  console.error(`not flagged: ${missed.join(", ")}`);
  process.exit(1);
}
