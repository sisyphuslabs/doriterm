# doriterm.com landing: design system

The marketing page for doriterm.com lives in `apps/landing/`: plain HTML, CSS and one ES module for the page, plus `mockup/index.html` (served at `/mockup/`, a folder index, so Workers static assets serve it without a redirect), which renders the app's own components with sample data. `bun run --cwd apps/landing build` (Vite) writes a static `dist/` that any static host serves as it is. It extends the product's [DESIGN.md](../../../DESIGN.md): the colours are the app's Night and Day palettes, and the status grammar and hairline depth carry over. This file covers only what a landing page adds: display type, a looser spacing scale, motion that explains, and the components the page is built from. Full-page captures are in this folder (`<width>-<theme>.png`, Chromium, reduced motion).

## Product rulings the page follows

- doriterm is a terminal. The page makes no file-editing or IDE claim, and the sample data shows terminals and coding agents only.
- The app lives at `https://app.doriterm.com`; doriterm.com is this page. Every primary button says **Open the app** and goes there; the desktop download is the secondary action.
- Hero copy is the owner's: the headline `Your devices. One terminal.` (two beats) and directly under it `Every machine you own, linked through an end-to-end encrypted mesh.`
- Any view of the app inside a window or phone frame is the app's components rendered live, never a screenshot (section 5, "Live mockups").

## 0. Research

| Source                             | What it does                                                                                                                                                                                                                                                          | What we took                                                                                                                                                                                | What we left                                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [herdr.dev](https://herdr.dev)     | Geist at 96 px / weight 560 for the hero, the second line of each headline in a muted grey; a numbered `README.md` index of sections with `##` headings; the product's own sidebar drawn in HTML instead of a screenshot; one white pill button as the primary action | two-tone display headlines, weight 560, the numbered section index, product surfaces drawn as live HTML/SVG, the solid ink pill as the only primary button                                  | the wall of user-made window screenshots (we have no gallery) and the sticky left index column                                   |
| [ghostty.org](https://ghostty.org) | a terminal window frame centred as the hero, with an animated ASCII scene inside; one sentence of description; two buttons; JetBrains Mono for anything technical                                                                                                     | the window frame (traffic-light dots, centred mono title, hairline bar) as the container for every diagram, JetBrains Mono for code and labels, a single animated scene as the hero's proof | the full-viewport ASCII art and the blue accent on the primary button                                                            |
| [omo.dev](https://omo.dev)         | the component family of our sibling product: uppercase tracked nav links, squared 4 px buttons with one solid primary, hairline window frames with a centred title, a live product surface beside or below the headline, a numbered feature list, a column footer     | squared buttons and switch (4 px), uppercase tracked nav and micro labels, hairline frames at 8-10 px, the live-surface hero, the numbered feature index                                    | its cyan accent (doriterm keeps its blue and amber) and the install-command tab block (doriterm ships an app, not a CLI install) |
| [trygoat.ai](https://trygoat.ai)   | a centred display headline over a static dot field, a pill-shaped floating nav, and a fleet section: a dot-matrix drawing of a hub linked to machine boxes that fill as they work, stepping through scenes with a short caption each                                  | the centred hero over a dot field, the floating pill nav, the dot-matrix fleet drawing in four captioned scenes (link up, work, join, revoke)                                               | its world-map backdrop and the scroll-pinned stage (the fleet steps on a timer and on click instead)                             |

## 1. Colour

The page uses DESIGN.md's Night (dark) and Day (light) values and adds three landing roles. `:root` follows `prefers-color-scheme`; the System / Light / Dark switch in the nav pins `data-theme` on `<html>` and stores the choice in `localStorage` (`doriterm-theme`). An inline script in `<head>` applies the pinned value before first paint.

| Token                                  | Dark                            | Light                           | Use                                                                                        |
| -------------------------------------- | ------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------ |
| `--bg`                                 | `#0f0e0d`                       | `#fbfaf7`                       | page                                                                                       |
| `--bg-raised`                          | `#141311`                       | `#f6f5f1`                       | cards, window bars                                                                         |
| `--surface` / `--surface-2`            | `#191816` / `#211f1c`           | `#ffffff` / `#f0efea`           | nodes, pressed segment                                                                     |
| `--term-bg`, `--term-fg`, `--term-dim` | `#121210`, `#d8d4cb`, `#8c877d` | `#fbfaf7`, `#2a2723`, `#6f6a61` | inside window frames                                                                       |
| `--ink`                                | `#eeeeef`                       | `#1b1b1e`                       | headings, body emphasis                                                                    |
| `--ink-2`                              | `#a8a49b`                       | `#5c5850`                       | body text, second headline line                                                            |
| `--ink-3`                              | `#6e6a62`                       | `#9a958b`                       | decoration only, never text                                                                |
| `--line` / `--line-strong`             | ink at 9 % / 16 %               | ink at 9 % / 16 %               | hairlines, control edges                                                                   |
| `--accent`                             | `#9fb4e6`                       | `#2f5fc4`                       | section numbers, focus ring, terminal output packets, mesh edges                           |
| `--cipher`                             | `#e2b86b`                       | `#8a5a00`                       | anything encrypted: ciphertext, keystroke packets, the relay outline, the pairing fragment |
| `--ok`                                 | `#8fcf9a`                       | `#2f7a3e`                       | keys that stay on a device, a matched fingerprint                                          |
| `--danger`                             | `#ef7d6b`                       | `#bf3a2b`                       | a revoked mesh member                                                                      |
| `--primary` / `--primary-ink`          | ink / bg                        | ink / bg                        | the one solid button                                                                       |

Rules:

- One hue, one meaning. Amber is ciphertext and only ciphertext; blue is output and structure; green is a key or a check; red is revocation.
- `--ink-2` is the lightest text colour. `--ink-3` fails text contrast on purpose and is used only for rules and dots.
- The primary button is solid ink, not accent (DESIGN.md section 2).

## 2. Type

Every font on the landing is Timeless Sans (timeless.co/type, Timeless Ventures, free for personal and commercial use under the Timeless Free Font License 1.3, shipped as a WOFF2 subset to Latin-1, General Punctuation, arrows and the page's symbols, with every name record and variation axis kept, and a copy of the license at `public/fonts/LICENSE-timeless.txt`). The display headline and section headings use it too, at weight 560; Timeless Serif was dropped in the renewal to save a 75 kB preload. Timeless has no monospace, so JetBrains Mono (variable, OFL) sets the inside of terminal panes and nothing else (`--font-term`).

| Token            | Size                                | Weight  | Tracking          | Use                                  |
| ---------------- | ----------------------------------- | ------- | ----------------- | ------------------------------------ |
| `--text-display` | clamp(44 px, 1.4rem + 5.6vw, 96 px) | 560     | -0.04em           | hero headline, line-height 0.98      |
| `--text-h2`      | clamp(32 px, 1.3rem + 2.8vw, 56 px) | 560     | -0.03em           | section headline, max 18ch, balanced |
| `--text-h3`      | 20 px                               | 600     | -0.015em          | card title                           |
| `--text-lede`    | clamp(17 px, 1rem + 0.35vw, 20 px)  | 400     | 0                 | hero and section lede, max 60ch      |
| `--text-body`    | 16 px                               | 400     | 0                 | body                                 |
| `--text-sm`      | 14 px                               | 400/500 | 0                 | lists, nav                           |
| `--text-xs`      | 12 px                               | 400     | 0.04em, uppercase | eyebrows, mono labels                |

Every headline is two-tone: a plain statement in `--ink`, then the consequence in `--ink-2` (herdr's pattern). Numbers that matter are tabular.

## 3. Spacing, layout, radius

4 px base: `--space-1..10` = 4, 8, 12, 16, 24, 32, 48, 64, 96, 144 px. Content width 1200 px plus a fluid gutter (`clamp(20px, 4vw, 40px)`). Sections are separated by 144 px (96 px under 760 px).

Breakpoints: 480 (below it the hero's two actions stack, full width up to 320 px), 640 (two-column lists and the section index's descriptions from here; below it the mesh canvas and its scene buttons take their phone layout and the app's desktop window is hidden), 760 (below it the facts, the makers, the section index and the pairing output go to one column, sections and cards tighten, and the nav hides Open the app), 860 (the nav hides its section links below this width), 900 (three-column cards and mesh facts, the relay pipe in one row, pairing side by side, and the phone frame overlapping the app window's corner), 1080 (the hero's top padding grows).

| Radius          | Value  | Use                              |
| --------------- | ------ | -------------------------------- |
| `--radius-xs`   | 4 px   | inline highlights                |
| `--radius-sm`   | 6 px   | copy button, ciphertext chips    |
| `--radius-md`   | 8 px   | QR plate, icon tile              |
| `--radius-lg`   | 8 px   | cards, code block, diagram nodes |
| `--radius-xl`   | 10 px  | window frames, the mesh stage    |
| `--radius-pill` | 999 px | chips and the relay node         |

Depth: tonal steps and 1 px hairlines as in the app. Window frames are the one place with a shadow (`--shadow-frame`), because they stand for real windows.

## 4. Motion

Motion on this page explains a mechanism; nothing moves for decoration alone.

| Token             | Value                             | Use                                                                      |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------ |
| `--dur-press`     | 120 ms                            | button press (scale 0.97)                                                |
| `--dur-ui`        | 220 ms                            | hover, theme change, highlight                                           |
| `--dur-enter`     | 900 ms                            | scroll reveal (16 px rise + fade)                                        |
| `--dur-draw`      | 1200 ms                           | a mesh edge drawing in                                                   |
| `--dur-loop`      | 3.2 s                             | the relay pulse, packet trips                                            |
| `--ease-reverb`   | `cubic-bezier(0.1, 1, 0.1, 1)`    | enters and draws: fast launch, long settle                               |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)`      | UI feedback                                                              |
| `--ease-exit`     | `cubic-bezier(0.3, 0, 0.8, 0.15)` | a revoked edge retracting                                                |
| packets           | spline `0.45 0 0.55 1`            | ease in and out of each endpoint, so a packet visibly leaves and arrives |

Scenes:

- Hero: no animation of its own. Under the headline sits the app itself (the window and phone described under Live mockups), so the first thing a visitor sees is the product: OmO first in the tabs, Claude Code and Codex after it.
- Mesh (section 01, right under the hero): one canvas draws the relay as a 5x5 amber block and five machine boxes as dot matrices. Arrivals use the reverb curve `cubic-bezier(0.1, 1, 0.1, 1)` over 900 ms with a 50 ms stagger, load changes Material standard over 700 ms, and sealed records travel the links on `cubic-bezier(0.4, 0, 0, 1)` (move within the frame), turning blue only for the last stretch into the machine they are for. Scenes advance every 5.6 s and on click; drawing runs only while the figure is on screen, and reduced motion draws each scene settled with two sealed records parked on their links. In the join and revoke scenes a signed record (green for admit, red for revoke) leaves the laptop, crosses the relay and reaches every member before the machine joins or is cut off; the revoked machine keeps working until its record lands.
- Relay pipe: the phone types a command, the wire carries ciphertext chips both ways, the server prints the result.
- Pairing: the QR is scanned, the fingerprint groups are compared one by one, then turn green.

Every loop runs only while its scene is on screen and the tab is visible (IntersectionObserver plus `visibilitychange`). With `prefers-reduced-motion: reduce`, no loop starts, packets and scan lines are hidden, reveals show at once, and each scene shows a complete still frame: the pipe with its command and result, the fingerprint matched, the mesh with five members.

## 5. Components

| Component        | Class                                      | Anatomy                                                                              | States                                                                                         |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Nav              | `.nav`                                     | wordmark (mascot mark swaps per theme), section links, theme switch, Open the app    | sticky, translucent `--bg` with blur; section links hide under 860 px, the button under 760 px |
| Theme switch     | `.theme-switch`                            | three icon buttons (System, Light, Dark) with visually hidden labels                 | `aria-pressed`; hover ink; 2 px focus ring                                                     |
| Button           | `.btn--primary`, `.btn--ghost`, `.btn--sm` | squared (4 px), 44 px tall (34 px small)                                             | hover tone, 0.97 press, arrow nudges 3 px on hover                                             |
| Eyebrow          | `.eyebrow`                                 | mono number in accent, 28 px rule, uppercase label                                   | none                                                                                           |
| Section headline | `.h2` with `.soft`                         | two-tone, balanced                                                                   | none                                                                                           |
| Window frame     | `.frame`                                   | 38 px bar: dots, centred mono title, mono meta; body                                 | none                                                                                           |
| Terminal text    | `.term`                                    | mono 13 px; `.prompt` accent, `.dim`, `.ok`, `.hl` (amber)                           | blinking block caret (stopped under reduced motion)                                            |
| Feature card     | `.card`                                    | 36 px accent icon tile, h3, body, optional mono `.meta`                              | hover edge                                                                                     |
| Code block       | `.code`                                    | bar with label and Copy, mono body with dim comments                                 | Copy -> Copied (1.6 s)                                                                         |
| Chip             | `.chip`                                    | pill, Timeless Sans 12 px, leading dot                                               | none                                                                                           |
| Section index    | `.index`                                   | numbered rows, title, description (from 640 px)                                      | hover ink                                                                                      |
| Relay wire       | `.wire`                                    | dashed amber container, two lanes of ciphertext chips (opposite directions), caption | marquee                                                                                        |
| Mesh canvas      | `.fleet`                                   | step buttons, one canvas, caption                                                    | scene change, signed-record fan-out                                                            |
| Footer           | `.footer`                                  | wordmark, four links                                                                 | hover ink                                                                                      |

### Live mockups

The window and phone in the hero are `<iframe>`s of `/mockup/?view=desktop` (1280 x 780) and `?view=phone` (390 x 844). That page imports `@doriface/ui`, the component set `apps/web` is built from (SidebarSection, SpaceRow, AgentRow, TabBar, TerminalPreview, StatusBar, StatusChip, ExtraKeysBar), with Tailwind and the app's tokens, and renders them with the fixtures in `apps/landing/src/mockup/fixtures.ts`. The landing never loads React or the app's stylesheet itself:

- Isolation: the iframe keeps Tailwind's preflight and the app's tokens off the landing, and the landing's styles off the app.
- Size: `main.js` scales each frame to its box with a ResizeObserver (`--scale`), so the app keeps its own pixel layout at every width. Below 640 px only the phone is shown.
- Loading: the frames sit in the hero but start loading only after the page's `load` event and an idle callback (a 1 ms timeout where the browser has none, as in Safari), and a frame the layout hides (the desktop window on phones) never loads. The headline text stays the LCP element, and the 150 kB (gzip) mockup bundle loads in the frames after it.
- Theme: the mockup follows `prefers-color-scheme` like the page; when the switch pins Light or Dark, `main.js` posts `{ theme }` to each frame (same origin only), which pins the app's Day or Night preset.
- Inert: the mockup's body is `inert` and the iframe has `tabindex="-1"`, so it takes no focus or input; each iframe has a `title` saying it is the app drawn with sample data.

### Performance and headers

Measured with Lighthouse 12 on the built page served with `public/_headers`' CSP: after the renewal: mobile 96-97 performance (LCP 2.6 s simulated, CLS 0, TBT 0-10 ms, 297 KiB total), desktop 100 (LCP 0.6 s); accessibility, best practices and SEO 100 on both. What keeps it there: the hero has no scroll reveal (its text is the LCP element), Timeless Sans and JetBrains Mono are preloaded so the swap moves nothing, and the mockup frames load after the headline paints. `public/_headers` sets the CSP (`script-src 'self'`; the pre-paint theme script is the external `theme-init.js`), `X-Frame-Options: SAMEORIGIN` so the page can frame its own mockups, and long caching for hashed `/assets/*`. `og.png` and `robots.txt`/`sitemap.xml` come from #771.

## 6. Claims and their sources

Every product statement on the page is backed by this repository. A change to one of these lines changes the page.

| Claim on the page                                                                                                                                                                              | Source                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Sessions use Noise IK; pairing uses IKpsk2; X25519, ChaCha20-Poly1305, BLAKE2s                                                                                                                 | `packages/crypto/src/noise/handshake.ts:11-13`                                            |
| Rekey every 2^20 messages                                                                                                                                                                      | `packages/crypto/src/transport.ts:6`                                                      |
| The relay keeps no accounts and stores no messages; ciphertext only                                                                                                                            | `docs/architecture.md:28`, README "How it fits together"                                  |
| What the relay can see: host ids, addresses, timing; nothing it can forge, replay or splice                                                                                                    | `docs/transport.md` "What the relay learns from a mesh", pairing table rows `0x02`/`0x03` |
| With a typed code, a relay answering as a fake host can read message 1 (the device name); the fingerprint check then shows a key that is not the host's                                        | `docs/transport.md:84` (typed code, lying lookup)                                         |
| The pairing secret is in the URL fragment, which never reaches a server                                                                                                                        | `docs/transport.md:82`                                                                    |
| 8-character typed code behind CPace; no offline guessing; at most 10 answers per offer                                                                                                         | `packages/crypto/src/pairing.ts:10-14`, `docs/transport.md:83`                            |
| Code printed as two groups of four; fingerprint as ten groups of four hex digits                                                                                                               | `packages/crypto/src/pairing.ts:41-44`, `packages/crypto/src/identity.ts:32`              |
| A pairing offer lasts 10 minutes                                                                                                                                                               | `apps/host/src/commands/pair.ts:78` (`PAIRING_TTL_MS`)                                    |
| A changed host key is refused unless you confirm (`--replace`)                                                                                                                                 | README "Other machines through the relay"                                                 |
| Mesh: Ed25519-signed records, approval before admit unless the offer was opened with `--auto`, 7-day new-member notice, `--compromised` revokes transitively, sessions closed and keys refused | `docs/transport.md` "Mesh" (records, `mesh pair`, `mesh revoke`, new-member notice)       |
| Each member adds every other member as a herdr machine                                                                                                                                         | `docs/transport.md` "Mesh", `machine.add --via` line                                      |
| No ssh and no open port                                                                                                                                                                        | README "Other machines through the relay"                                                 |
| libghostty compiled to WebAssembly from Ghostty's source                                                                                                                                       | README status table, `packages/ghostty-wasm`                                              |
| Desktop app installs herdr-core when missing and offers this computer to a phone                                                                                                               | README status table (#417, #614)                                                          |
| Browser versions                                                                                                                                                                               | README "Browsers", `apps/web/src/baseline.ts`                                             |
| AGPL-3.0                                                                                                                                                                                       | `LICENSE`                                                                                 |

Illustrations that are not claims: the QR encodes `https://doriterm.com`, the code `7KQ4 M2XD` and the fingerprint digits are samples, and the terminal output in the pipe is example output.
