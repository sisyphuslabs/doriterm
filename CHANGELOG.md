# Changelog

## Unreleased

## v0.1.4 - 2026-11-06

### The product is Doriterm

- The app is **Doriterm** everywhere a name shows: the bundle and its executable, the window title, the About and Help menus, notification titles, the PWA manifest and the tab title, the sidebar, the first-run and pairing copy, the exported terminal and keybinding files, the docs, and every GitHub link. The app id, the storage directory, the local keys, the `doriface://` link scheme and the wire contract stay as they are, so an installed app keeps the computer it paired and its settings. (#739)
- Upgrading from 0.1.x: the app id and the storage folder do not move, so an update keeps the devices and settings an install already has. What changes on disk is the name: a macOS install that updates in place keeps its existing bundle folder (`/Applications/doriface.app`) and shows Doriterm in the Dock and menus, while installing the dmg fresh gives `/Applications/Doriterm.app`; the Linux deb launches as `/usr/bin/Doriterm`; the Windows installer updates the folder it recorded before. If you install the new dmg while the old one is still in /Applications, remove the old doriface.app; an in-place update does not need this. (#739)

### The hosted web app

- The hosted web app answers at **https://app.doriterm.com** (staging at https://staging.app.doriterm.com). https://doriface.omo.dev keeps serving the same build, so an installed app and links already shared keep working. (#857)

### Host install

- On macOS, running `install.sh` again over a host already installed waits for launchd to unload the old LaunchAgent before it registers the new one, instead of failing with `Bootstrap failed: 5`. (#908)

### Settings

- Settings opens as a dialog over the workspace on a wide screen: the terminals stay in view behind it and keep drawing, so a theme, density or text-size change shows on them as it is made, and Escape or a click on the dimmed backdrop returns to the focused pane (in the desktop app the strip over the window's title bar still moves the window). Appearance gains a Text size row beside theme and density. A phone keeps the full-screen sheet. (#843)

### Website

- The doriterm.com landing page shows OmO running in the hero window and the machines of a fleet as a dot matrix around the relay, and introduces the people who make it. (#911)

### Native apps

- The push bridge keeps a device's subscription when FCM answers a bare 404, and stops reading a chunked request body at its size cap. (#838)

### Documentation

- The GitHub social preview uses the landing page's Timeless card, and the design and architecture docs name what they cite correctly. (#802, #804, #866)

### Settings

- Settings on a phone no longer shows the agent list's Pin and More buttons drawn over its sections: nothing of the workspace kept behind the full-screen Settings sheet is drawn while it is open. (#898)

## v0.1.3

### This computer on the relay, and pairing from a phone

- One step installs a host on Linux or macOS: `install.sh` (a release asset) checks the download against `SHA256SUMS.txt`, installs herdr-core when `hc` is missing, registers the host as a user service that starts at login and restarts if it stops, and prints the pairing QR code, link and code — running it again upgrades in place, and `--uninstall` removes it and keeps the keys. The code waits for a host that is still starting and for the relay to register it, so the first code it prints works. (#721)
- The host the desktop app starts joins the relay, so a phone or another computer can pair with this computer by code or link and reach its terminals. (#597)
- Settings > Connections has **Pair a device**: it asks this computer's host for a fresh offer and shows its QR code, link, 8-character code, fingerprint and expiry, then the device that used it — no terminal and no CLI. (#638)
- Settings > Connections lists the devices paired with this computer and revokes one after asking: its session ends at once, its notifications stop and its key is refused, so a lost phone no longer needs a terminal on this computer. (#729)
- The web app is hosted at https://doriface.omo.dev, and the pairing QR code (in **Pair a device** and from `doriface-host pair`) opens its pair page on a phone, with the host's key ready to check. The link for another computer stays `doriface://pair#…`. (#713)
- A pair link printed with no `--web-origin` opens the desktop app, instead of a hostname the release never served. (#595)
- A plain LAN Direct address works in the desktop app: the app forwards the page's bytes and reads none of them. (#601)
- A saved Direct address carries the session with it, and the relay is its fallback. (#598)
- Settings keeps naming the host it is paired with after that host stops answering, instead of showing its 26-character id. (#600)
- A newly paired device walks through its first run: pair, start or open an agent, then see it in the agents list. Each step completes on its own, the guide can be skipped, and Settings > Device > **Getting started** shows it again. (#723)

### Answering agents from the card

- The card pinned over a waiting agent answers every prompt shape Claude Code and Codex draw, not only Allow or Deny: each of the agent's own rows with its key, its questions (one or several in a row, multi-select, a typed answer), and a plan to approve. It shows what the agent said above the question, the directory it works in, and the diff or file it touches, and a file it names opens read-only. Every answer is still checked against the live screen first. (#736)
- A notification offers its prompt's own rows: a one-question prompt's rows become the notification's actions, the No row answers from the notification, any other row opens the app and its page sends the answer, and the answer is still checked against the live screen. Several steps or a typed answer offer no rows, and a tap opens the card. (#745)

### A browser on the mesh, and the installed web app

- A browser with no account and no pairing opens the web app, follows an invite link a member sent, checks the host's fingerprint and lands on the mesh's terminals; a revisit needs no new invite. (#716)
- A mesh invite (`&m=1`) is no longer read as a device invite: the web app says it adds a machine, with the command that does, instead of reporting a link that was already used. (#716)
- The installed web app carries its own app id and language, ships a maskable icon at 192 as well as 512, and opens standalone from an iOS home screen with its own title and status bar. (#715)
- The hosted web app sends a Content Security Policy: its own scripts and the terminal's wasm, this origin and the relay, nothing else, and every deploy probes for the header. (#743)

### Machine mesh

- A machine you had already added over ssh or with a via is replaced by its mesh line under the same name, and mesh status and the Mesh panel say what kind of entry it replaced. Its open tabs and layout carry over. (#712)
- Settings > Mesh shows the mesh this computer is in instead of "Not in a mesh": the host publishes its mesh status like its own facts, and a host in no mesh writes that it is in none, so a mesh it left is never read as the current one. (#761)
- **Add a machine** is one command: the dialog asks this host for a single-use mesh offer and shows one `curl -fsSL …/install.sh | sh -s -- --join '<link>'` to run on the machine to add, which installs the host, runs it as a service and joins this host's mesh; the cores then add each other as machines, and the dialog says when it joined, with the three hand-run steps left under **Advanced**. (#831)

### The phone

- The phone terminal has a held touch, a field and a two-slot keys bar, with the input beside a scrolling key strip and a keyboard toggle that stays put. (#680, #682)
- A one-tap ^C sits after Esc in the phone key row. (#678)
- A syllable still composing is finished before a key-bar key, a chord or a paste, so the bar never eats it and never sends the syllable twice. (#718, #738)
- The phone draws its sort control only when an agent can be sorted. (#657)
- The phone's list says it is loading until the host's first list answers, instead of showing "No terminals yet" on every load. (#807)
- A held touch's menu stays open when the finger lifts, and the selection it made survives: the tap a lift would make belongs to the hold, not to the menu. (#845)
- An agent row's Pin and More are drawn on a touch screen, 24 px apart, so each takes a 44 px tap instead of waiting for a hover that never comes. (#808)

### Native apps

- A push bridge for the coming iOS and Android apps: the host's encrypted notices reach them through APNs and FCM, and the bridge never holds a key that opens one. (#717)
- An Android app around the same web build, with its notifications through the bridge and Allow and Deny on the notification itself. (#810)
- An iOS app around the same web client: a Notification Service Extension opens each notice with the app's own keys, so the text is shown without the bridge or Apple reading it. (#846)

### Spaces, tabs and the sidebar

- Ctrl+1-9 show the space at that place in the sidebar, and Cmd+Alt+] and Cmd+Alt+[ step through the spaces and wrap (Ctrl+Alt on Windows and Linux). There the tab number chords move from Ctrl+1-9 to Alt+1-9. (#626)
- A space moves up or down within its machine, by drag or from its menu, and the order is written to the shared layout document, so every device of the host reads it without a reload. (#622)
- A space's menu can close the whole space: it says how many tabs and terminals go, ends every program they run, and takes the space out on every device. (#620)
- A tab's menu hands the keyboard to the question its item opened, so a rename typed at once is kept. (#591, #632)
- Right-clicking a sidebar row opens its menu, so Rename is there without the "..." button. (#720)
- The sidebar toggle takes a click on macOS with the sidebar hidden or in a rail, a click on it is not a window drag, and the tab strip still moves the window beside it. (#646, #659, #690)

### Fonts, Korean text and the terminal

- A latched Ctrl, Alt or Cmd reads a Hangul letter as its 2-set key, and a Ctrl chord whose key is a Hangul letter sends that physical key's control byte, so ctrl+ㅊ is ^C. (#675, #714)
- A fallback Hangul face is sized to Ghostty's ideograph width, not the whole two cells. (#658)
- Wide glyphs in a terminal that opened in a tab not shown are drawn once the tab is shown. (#649)
- A press's selection is held by the terminal rather than the document, so IME composes after a drag-select. (#593)
- A resize keeps the terminal's view: a following terminal keeps following through a divider drag or the phone keyboard, a program's redraw during one is written whole instead of paced, and only a scroll of your own stops it following. (#811)
- An image pasted into a terminal, or a file dropped on one, goes to that terminal's machine — this one or an added one — and its path is pasted there, so an agent on that machine can read it; text and Ctrl+V paste as before, and **Paste image** can be bound in Settings > Keybindings. (#742)

### Connection and offline wording

- An attempt has a deadline that bounds the whole attempt and grows after each timeout, so a link that never settles cannot leave the page on "Connecting"; a direct race whose host stalls falls back to the relay. (#719, #740)
- A relay that never answers the upgrade fails at its bound instead of holding the connect open. (#631)
- The page waking runs a reconnect at once, and a link that keeps dropping keeps backing off. (#654)
- A connection that answered no hello still opens, so a name never fails a session. (#633)
- A layout write whose link drops under it says so plainly, never the closed link's raw cause. (#724)
- Coming back from Settings keeps your terminals running instead of replaying their history. (#607)
- Moving this device to another host in Settings moves its notifications with it: the host it leaves drops the subscription and the new host gets it. (#627)
- A page that comes back — a tab shown again, a page restored from the back/forward cache, the network returning — while its link still looks open asks the host once, and a link that does not answer within 10 seconds is dropped and reconnected at once instead of leaving the terminal frozen until the 45-second heartbeat gives up; a link that answers, even with a refusal, is left alone. (#775)
- A pane in a tab that is not on screen no longer re-attaches and pulls its 2,000-line scrollback over the link, so the pane in front of you and your typing do not compete with a replay nobody sees; it attaches when the tab is shown. (#731)

### A core this client cannot use

- A core the client cannot use fails for good instead of being retried forever, and says which side to update from one shared version floor; a core build missing a method the workspace calls says so at the handshake. (#662, #686, #689, #697)

### Done, idle and errors

- An agent that finished while its pane was not on screen keeps its dot, its row under **Done** and its space's mark until this screen shows that pane; another device that never showed it still says Done. (#628)
- A render error shows a crash screen or a region notice with Try again, never a blank or bare screen. (#660)

### Linux

- The AppImage carries its own FUSE runtime, so stock Ubuntu 24.04 opens it without installing FUSE 2 first. (#629)

### Website

- doriterm.com has a landing page: "Your devices. One terminal.", the app shown live from its own components, pairing by QR or code, the mesh, and the relay as a ciphertext-only pipe, each as an animation that stops under reduced motion, in dark and light, with OmO as the agent shown first. (#735, #880)

### Reliability

- A launch still opening when the host stops is ended, so its core cannot outlive the host. (#599)
- The host reads one typed plan document that is open unless it names a limit or a feature, and a document that cannot be read as one stops the host instead of reading as an open plan. (#606)
- Many test, CI and documentation fixes, so problems are caught before a release instead of after. The phone keys bar's keys, packs and custom keys are now a stored model, and a modifier held in the bar now covers Home, End, Page Up, Page Down, Delete and F1 to F12 as well as the arrows, so a keyboard attached to a phone carries the modifier too. (#605, #608, #613, #617, #624, #681, #683, #685, #687, #695, #711, #725, #741, #762, #763, #765, #784, #785, #788, #815, #826, #828, #847, #863, #872, #876, #885)

## v0.1.2 - 2026-11-06

### Tabs and spaces

- Tabs belong to a space, as in herdr-app: the tab bar shows the selected space's tabs, each space remembers the tab it showed, and the tab order is the same on every device. A new tab opens right after the one you are on. (#466)
- Rename a space from its menu, the command palette or a double-click; the new name shows on every device. (#416)
- Closing a tab or pane ends its program, and asks first only when the program is still busy; a close that needs no question shows none. (#426, #534)
- A tab follows its machine through a rename. (#495)
- A tab moved while its machine is being renamed stays visible: its layout follows the machine to the new name. (#589)
- A double-click on the tab after the selected one renames it instead of closing it. (#573)

### Sidebar and titlebar

- One sidebar toggle, placed after the macOS window buttons, and a titlebar laid out like herdr-app's. (#445)
- Agents sit at the bottom of the sidebar with a split you can drag, and two spaces with the same name show as separate rows. (#421)
- A machine's header keeps its name ahead of its state, and its buttons have tap areas that don't overlap. (#504)
- The machine header is labelled with the machine's name and state. (#579)
- The desktop app waits for your saved tabs before showing "No terminal open", and a terminal that is still opening says so. (#489)
- Native notifications in the desktop app, using the same triggers and settings as web push. (#412)

### Fonts, Korean text and the terminal

- Terminal text matches Ghostty's metrics, and wide Hangul fits its cells. (#430)
- Korean wraps between words, and a row's icon lines up with its first line. (#487)
- Copied text drops trailing spaces and blank rows, as Ghostty does; Ctrl+Shift+V and Shift+Insert paste; a double- or triple-click selection keeps the keyboard in the terminal. (#528, #532, #530)
- The Ghostty `theme` key accepts any theme in Appearance, by name or id. (#533)
- The import dialogs' line numbers are readable in both themes. (#484)
- On the phone, a long terminal title gets a second line instead of being cut. (#485)

### Connection and offline wording

- Offline, the status bar says the app reconnects when the network is back and offers Try again, and no machine shows as connected while you are offline. (#493)
- Settings explains in words why a host can't be reached; the raw error code is under Details. (#486)
- Coming back from Settings keeps your sessions and reconnects at once. (#456)
- Reload to update now always lands on the new version. (#539)
- There is no Direct address field any more; the relay is shown without an edit field. (#460)
- A machine list that cannot be read says so plainly, with the error under Details, instead of a raw error beside the connection notice. (#552)

### Desktop local host and pairing by code

- If the desktop app's local host has stopped, it is started again before reconnecting. (#525)
- Pairing by code works in the desktop app's release build. (#544)
- The token for this computer's host is only ever sent to this computer. (#463)

### Windows

- The app's state lock no longer trips over a state folder that Windows is still deleting. (#524)
- On Windows arm64, the state lock reads why a file could not be opened from Windows' own status, so a worker no longer dies on a failed open that reports no error. (#578)
- Both Windows installers, x64 and arm64, are now installed and started on a clean machine before each release is published. (#451)
- Windows builds are still not code signed, so SmartScreen warns on first run; see Code signing below.

### Reliability

- A terminal on a link that just dropped no longer throws an error into the page. (#465)
- A stopped host never restarts its terminal core behind your back. (#455)
- Relayed sessions are faster on bulk output and handle split frames correctly. (#517)
- A terminal that floods output no longer slows the app: output is drawn at most once a frame, flow control holds the program back until it is drawn, and hidden panes draw nothing. (#586)
- Ending a terminal reaches the host even when the page closes right after you confirm. (#582)
- A host in a large mesh acknowledges its own changes without re-reading the whole mesh each time. (#577)
- The desktop app's content security policy stays strict while scroll areas hide their native scrollbars. (#520)
- The app starts and keeps working when the browser refuses storage, as private windows and blocked site data do. (#550, #554)
- On phones, the app, its header, its status bar and its sheets keep clear of the notch, the rounded corners and the home indicator on every side. (#561, #565)
- An older browser gets an Update your browser screen instead of a page that does not work. (#563)
- Many test and CI fixes, so problems are caught before a release instead of after. (#444, #450, #453, #457, #467, #471, #490, #491, #492, #494, #498, #501, #505, #506, #507, #508, #511, #513, #514, #519, #523, #531, #536, #538, #541, #543, #546, #549, #558, #564, #569, #571, #574, #575, #585, #588)

## v0.1.1 - 2026-11-05

### Signed macOS app and Windows

- The macOS app is signed with a Developer ID certificate and notarized by Apple, and the dmg is stapled, so it opens without a Gatekeeper warning. (#382)
- On Windows, the host keeps its keys and private state readable only by you, and it refuses a herdr-core older than 0.1.17. (#433)
- The app installs herdr-core for you when it is missing or too old: a verified download, installed for your user only. (#417)
- Release builds connect only to the production relay. (#411)

### Panes, spaces and the terminal

- Drag a pane by its header to move it within its tab, as in herdr-app, or swap panes from the keyboard. (#442)
- A space row shows its branch, ahead or behind, uncommitted changes or a detached head, only when one of them is unusual. (#380)
- Cmd/Ctrl + and - and 0 size the terminal text instead of zooming the whole window. (#413)
- A selection covers whole cells and stays contiguous across wide characters. (#437)
- Keys you type while a terminal opens on its own are kept, and a terminal that answers after you moved on no longer takes the keyboard. (#414, #375)
- A terminal started again with Try again gets its focus back. (#386)
- The sidebar list and the tab strip show no classic scrollbars while their content fits. (#374)
- The browser's theme colour follows the theme you are looking at. (#371)

### Updates and Settings

- An update that is ready lights a dot on Settings, and Settings restarts or reloads into it; the phone's Settings gear shows the dot too. (#394, #425)
- Voice input says what dictation does and where its microphone is, and why it cannot listen when it cannot. (#398)

### Hosts and the mesh

- Stopping a host ends the handshakes in flight instead of waiting for them to time out. (#438)
- A link opened while its device is being revoked is closed. (#439)
- Re-pairing a host compares and saves it in one step, so two pairings at once cannot mix. (#396)
- Adding a machine reserves both of its relay connections together. (#373)
- Many test fixes, so problems are caught before a release instead of after. (#363, #370, #377, #378, #399, #400, #405, #407, #423, #428, #431, #432, #434, #436, #443)

## v0.1.0 - 2026-11-05

The first release: an end-to-end encrypted web, PWA and desktop face for herdr-core.

- The desktop app for macOS, Windows and Linux starts a host and herdr-core on your computer and shows its terminals; the same client runs in a browser and installs as a PWA.
- Every herdr-core method works unchanged: the host passes herdr-core's own protocol straight through.
- Terminals render with libghostty, built from Ghostty v1.4.0.
- Traffic between your devices and a host is end-to-end encrypted with Noise and carried by a public relay that only ever sees ciphertext.
- Pair a device with an 8-character code or a one-tap link, and add other machines through the relay with `hc machine add --via 'doriface-host connect <host>'`, with no ssh and no open port.
- Everything up to and including #367.
