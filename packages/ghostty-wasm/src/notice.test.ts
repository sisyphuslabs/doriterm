import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const NOTICE = readFileSync(join(ROOT, "NOTICE"), "utf8");
const SEPARATOR = /\n-{20,}\n/;
/** Each NOTICE section, keyed by the project URL on its heading line. */
const sections = new Map(
  NOTICE.split(SEPARATOR)
    .slice(1)
    .map((section) => [/\((https:\/\/github\.com\/[^)]+)\)/.exec(section)?.[1] ?? "", section] as const),
);

/** The MIT licence as Ghostty ships it, after its copyright line. */
const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

/** The Apache-2.0 notice: the licence appendix's boilerplate, unindented. */
const APACHE_NOTICE = `Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`;

/** licenses/Apache-2.0.txt is wterm's own LICENSE: vercel-labs/wterm at v0.5.9, byte for byte. */
const WTERM_LICENSE_SHA256 = "f1932dabb4856eb6f6cba683be864338e654012492642aeb59e5e48483f836c4";

test("Ghostty's section carries its copyright and the whole MIT licence", () => {
  const section = sections.get("https://github.com/ghostty-org/ghostty") ?? "";
  expect(section).toContain("Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors\n\n");
  const licence = section.slice(section.indexOf("MIT License\n\n") + "MIT License\n\n".length);
  const [copyright = "", ...rest] = licence.split("\n\n");
  expect(copyright.startsWith("Copyright ")).toBe(true);
  expect(rest.join("\n\n").trimEnd()).toBe(MIT_TERMS);
});

test("wterm's section carries its copyright and the Apache-2.0 notice, and the licence text is wterm's own, whole", () => {
  const section = sections.get("https://github.com/vercel-labs/wterm") ?? "";
  expect(section).toContain("Copyright 2025 Vercel, Inc.");
  expect(section).toContain(APACHE_NOTICE);
  const licence = readFileSync(join(ROOT, "licenses/Apache-2.0.txt"));
  expect(createHash("sha256").update(licence).digest("hex")).toBe(WTERM_LICENSE_SHA256);
});
