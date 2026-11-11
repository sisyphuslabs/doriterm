/** The download page `/` answers a browser with: every `/dl/` link, the visitor's platform first. */

interface Link {
  readonly key: string;
  readonly label: string;
}

interface Section {
  readonly id: "mac" | "win" | "linux";
  readonly title: string;
  readonly links: readonly Link[];
}

const SECTIONS: readonly Section[] = [
  {
    id: "mac",
    title: "macOS",
    links: [
      { key: "mac-arm64.dmg", label: "Apple silicon (.dmg)" },
      { key: "mac-x64.dmg", label: "Intel (.dmg)" },
      { key: "mac-arm64.zip", label: "Apple silicon (.zip)" },
      { key: "mac-x64.zip", label: "Intel (.zip)" },
    ],
  },
  {
    // Both builds, named by CPU: a user agent does not say which one this PC needs (#1298).
    id: "win",
    title: "Windows",
    links: [
      { key: "win-x64.exe", label: "x64 (Intel or AMD)" },
      { key: "win-arm64.exe", label: "ARM64 (Snapdragon)" },
    ],
  },
  {
    id: "linux",
    title: "Linux",
    links: [
      { key: "linux-x64.AppImage", label: "x64 AppImage" },
      { key: "linux-arm64.AppImage", label: "ARM64 AppImage" },
      { key: "linux-x64.deb", label: "x64 .deb" },
      { key: "linux-arm64.deb", label: "ARM64 .deb" },
    ],
  },
];

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** The platform a browser's user agent names, read for the page's order only and never kept. */
export function platformOf(userAgent: string): Section["id"] | null {
  if (/Windows/.test(userAgent)) return "win";
  if (/Macintosh|Mac OS X/.test(userAgent)) return "mac";
  if (/Linux|X11/.test(userAgent) && !/Android/.test(userAgent)) return "linux";
  return null;
}

export function downloadPage(origin: string, version: string | null, userAgent: string): string {
  const first = platformOf(userAgent);
  const sections = SECTIONS.toSorted((a, b) => Number(b.id === first) - Number(a.id === first));
  const list = sections
    .map(
      (section) =>
        `<section><h2>${section.title}</h2><ul>${section.links
          .map((link) => `<li><a href="/dl/${link.key}">${escapeHtml(link.label)}</a></li>`)
          .join("")}</ul></section>`,
    )
    .join("");
  const title = version === null ? "Download Doriterm" : `Download Doriterm ${escapeHtml(version)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#e8e8e8;background:#141414}a{color:#8ab4ff}}
h1{font-size:1.6rem}h2{font-size:1.1rem;margin-top:1.6rem}code{font-size:.95em}pre{overflow-x:auto}
</style>
</head>
<body>
<h1>${title}</h1>
${list}
<section><h2>The host, on Linux or macOS</h2><pre><code>curl -fsSL ${escapeHtml(origin)} | sh</code></pre></section>
<section><h2>Other files</h2><ul>
<li><a href="/dl/web.zip">The web app (.zip)</a></li>
<li><a href="/dl/SHA256SUMS.txt">SHA256SUMS.txt</a></li>
<li><a href="https://github.com/sisyphuslabs/doriterm/releases">Every release on GitHub</a></li>
</ul></section>
</body>
</html>
`;
}
